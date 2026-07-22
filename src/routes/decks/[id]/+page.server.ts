import type { PageServerLoad, Actions } from './$types';
import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db/index';
import {
	decks,
	deckCards,
	cardAssignments,
	collection,
	deckPendingRemovals,
	deckPendingReturnAssignments,
	deckSyncAdditions,
	proxyInventory
} from '$lib/server/db/schema';
import { eq, and, or, sql, count, inArray, isNull, isNotNull } from 'drizzle-orm';
import { computeLocation } from '$lib/server/location';
import {
	getByIds,
	getBySetColl,
	getByName as scryfallByName
} from '$lib/server/db/scryfall-sqlite';
import { syncOneDeck } from '$lib/server/sync-deck';
import {
	acknowledgeDeckSyncAdditions,
	applyPendingRemoval,
	convertDeckToLocal,
	dismissPendingRemoval
} from '$lib/server/deck-workspace';

async function packedAssignmentCount(deckId: number): Promise<number> {
	const [{ packed }] = await db
		.select({ packed: count() })
		.from(cardAssignments)
		.where(and(eq(cardAssignments.deckId, deckId), eq(cardAssignments.pulled, true)));
	return packed;
}

export const load: PageServerLoad = async ({ params }) => {
	const deckId = parseInt(params.id);
	if (isNaN(deckId)) error(404, 'Not found');

	const [deck] = await db.select().from(decks).where(eq(decks.id, deckId)).limit(1);
	if (!deck) error(404, 'Deck not found');

	// Get all deck cards with their assignments
	const dcRows = await db
		.select({
			dcId: deckCards.id,
			cardName: deckCards.cardName,
			quantity: deckCards.quantity,
			setCode: deckCards.setCode,
			collectorNumber: deckCards.collectorNumber,
			board: deckCards.board,
			isCommander: deckCards.isCommander,
			notes: deckCards.notes
		})
		.from(deckCards)
		.where(eq(deckCards.deckId, deckId));

	// Get all assignments for this deck (includes collection.scryfallId for SQLite enrichment)
	const assignments = await db
		.select({
			id: cardAssignments.id,
			deckCardId: cardAssignments.deckCardId,
			collectionId: cardAssignments.collectionId,
			proxyInventoryId: cardAssignments.proxyInventoryId,
			status: cardAssignments.status,
			pulled: cardAssignments.pulled,
			proxySetCode: cardAssignments.proxySetCode,
			proxyCollectorNumber: cardAssignments.proxyCollectorNumber,
			note: cardAssignments.note,
			printStatus: cardAssignments.printStatus,
			collSetCode: collection.setCode,
			collCollectorNumber: collection.collectorNumber,
			collName: collection.name,
			collFoil: collection.foil,
			collCondition: collection.condition,
			collLocationOverride: collection.locationOverride,
			collScryfallId: collection.scryfallId
		})
		.from(cardAssignments)
		.leftJoin(collection, eq(cardAssignments.collectionId, collection.id))
		.where(eq(cardAssignments.deckId, deckId));

	const pendingRows = await db
		.select()
		.from(deckPendingRemovals)
		.where(eq(deckPendingRemovals.deckId, deckId));
	const pendingReturnRows =
		pendingRows.length > 0
			? await db
					.select({
						pendingRemovalId: deckPendingReturnAssignments.pendingRemovalId,
						assignmentId: deckPendingReturnAssignments.assignmentId
					})
					.from(deckPendingReturnAssignments)
					.where(
						inArray(
							deckPendingReturnAssignments.pendingRemovalId,
							pendingRows.map((pending) => pending.id)
						)
					)
			: [];
	const returnIdsByPending = new Map<number, number[]>();
	for (const row of pendingReturnRows) {
		const ids = returnIdsByPending.get(row.pendingRemovalId) ?? [];
		ids.push(row.assignmentId);
		returnIdsByPending.set(row.pendingRemovalId, ids);
	}
	const pendingRemovals = pendingRows.map((pending) => {
		const allPendingAssignments = assignments.filter(
			(assignment) => assignment.deckCardId === pending.deckCardId
		);
		const exactReturnIds = returnIdsByPending.get(pending.id) ?? [];
		const exactReturnIdSet = new Set(exactReturnIds);
		const pendingAssignments =
			exactReturnIds.length > 0
				? allPendingAssignments.filter((assignment) => exactReturnIdSet.has(assignment.id))
				: allPendingAssignments;
		return {
			...pending,
			currentQuantity: allPendingAssignments.length,
			removeCount:
				exactReturnIds.length > 0
					? exactReturnIds.length
					: Math.max(0, allPendingAssignments.length - pending.targetQuantity),
			returnAssignmentIds: exactReturnIds,
			packedCount: pendingAssignments.filter((assignment) => assignment.pulled).length,
			assignedCount: pendingAssignments.filter((assignment) => assignment.status === 'assigned')
				.length,
			proxyCount: pendingAssignments.filter((assignment) => assignment.status === 'proxied').length
		};
	});
	const syncAdditionRows = await db
		.select()
		.from(deckSyncAdditions)
		.where(eq(deckSyncAdditions.deckId, deckId));
	const syncAdditionByDeckCard = new Map(
		syncAdditionRows.map((addition) => [addition.deckCardId, addition])
	);
	const pendingByDeckCard = new Map(
		pendingRemovals.map((pending) => [pending.deckCardId, pending])
	);

	// Batch-lookup scryfall data for all collection-linked assignments
	const assignmentSc = getByIds(assignments.map((a) => a.collScryfallId));

	type EnrichedAssignment = (typeof assignments)[number] & {
		typeLine: string | null;
		manaCost: string | null;
		cmc: number | null;
		priceUsd: number | null;
		imageUri: string | null;
		location: string | null;
	};

	// Group assignments by deckCardId (with location computed via SQLite data)
	const assignmentsByDcId = new Map<number, EnrichedAssignment[]>();
	for (const a of assignments) {
		if (!assignmentsByDcId.has(a.deckCardId)) assignmentsByDcId.set(a.deckCardId, []);
		const sc = a.collScryfallId ? assignmentSc.get(a.collScryfallId) : undefined;
		let location = null;
		if (a.status === 'proxied') location = 'proxy_box';
		else if (a.status === 'ordered') location = 'ordered';
		else if (a.collSetCode) {
			location = computeLocation(
				sc?.type_line ?? '',
				sc?.mana_cost,
				sc?.price_usd,
				a.collLocationOverride
			);
		}
		assignmentsByDcId.get(a.deckCardId)!.push({
			...a,
			typeLine: sc?.type_line ?? null,
			manaCost: sc?.mana_cost ?? null,
			cmc: sc?.cmc ?? null,
			priceUsd: sc?.price_usd ?? null,
			imageUri: sc?.image_uri ?? null,
			location
		});
	}

	const cards = dcRows.map((dc) => ({
		...dc,
		assignments: assignmentsByDcId.get(dc.dcId) ?? []
	}));

	const boardsFinal: Record<string, (typeof cardsWithFallback)[number][]> = {};

	// For view modes: enrich deck cards with type/image from SQLite.
	// Try set+collector match first; fall back to name lookup.
	// Note: expose `id` as alias for dcId — the Svelte template references `.id`.
	const deckCardsRaw = dcRows.map((dc) => {
		const sc =
			dc.setCode && dc.collectorNumber ? getBySetColl(dc.setCode, dc.collectorNumber) : undefined;
		return {
			id: dc.dcId,
			...dc,
			typeLine: sc?.type_line ?? null,
			manaCost: sc?.mana_cost ?? null,
			cmc: sc?.cmc ?? null,
			imageUri: sc?.image_uri ?? null,
			backImageUri: sc?.back_image_uri ?? null
		};
	});

	// Name-based fallback for cards without a set+collector match in SQLite
	const missingNames = [
		...new Set(deckCardsRaw.filter((c) => !c.imageUri && !c.typeLine).map((c) => c.cardName))
	];

	// SQLite lookup by name for each missing card (LIMIT 1 — picks arbitrary printing)
	const nameCache = new Map<string, ReturnType<typeof scryfallByName>>();
	for (const name of missingNames) {
		const row = scryfallByName(name);
		if (row) nameCache.set(name, row);
	}

	const deckCardsEnriched = deckCardsRaw.map((card) => {
		if (card.imageUri || card.typeLine) return card;
		const fb = nameCache.get(card.cardName);
		if (!fb) return card;
		return {
			...card,
			typeLine: fb.type_line,
			manaCost: fb.mana_cost,
			cmc: fb.cmc,
			imageUri: fb.image_uri,
			backImageUri: fb.back_image_uri,
			// Fill in collector number from cache only when set codes match
			collectorNumber:
				card.collectorNumber ?? (fb.set_code === card.setCode ? fb.collector_number : null)
		};
	});

	const cardImageByName = new Map(deckCardsEnriched.map((c) => [c.cardName, c.imageUri ?? null]));

	// Batch-query collection quantity per card name for the Missing indicator.
	const deckCardNames = [...new Set(dcRows.map((dc) => dc.cardName))];
	const collQtyRows =
		deckCardNames.length > 0
			? await db
					.select({
						name: collection.name,
						qty: sql<number>`CAST(SUM(${collection.quantity}) AS INTEGER)`
					})
					.from(collection)
					.where(inArray(collection.name, deckCardNames))
					.groupBy(collection.name)
			: [];
	const collQtyByName: Record<string, number> = {};
	for (const r of collQtyRows) collQtyByName[r.name] = r.qty;

	const availableProxyRows =
		deckCardNames.length > 0
			? await db
					.select({
						id: proxyInventory.id,
						cardName: proxyInventory.cardName,
						setCode: proxyInventory.setCode,
						collectorNumber: proxyInventory.collectorNumber,
						printState: proxyInventory.printState,
						location: proxyInventory.location
					})
					.from(proxyInventory)
					.leftJoin(cardAssignments, eq(cardAssignments.proxyInventoryId, proxyInventory.id))
					.where(and(inArray(proxyInventory.cardName, deckCardNames), isNull(cardAssignments.id)))
					.orderBy(proxyInventory.cardName, proxyInventory.setCode, proxyInventory.collectorNumber)
			: [];
	const availableProxyInventoryByName = new Map<string, typeof availableProxyRows>();
	for (const copy of availableProxyRows) {
		const key = copy.cardName.toLocaleLowerCase();
		const copies = availableProxyInventoryByName.get(key) ?? [];
		copies.push(copy);
		availableProxyInventoryByName.set(key, copies);
	}

	const collectionPrintingRows =
		deckCardNames.length > 0
			? await db
					.select({
						id: collection.id,
						name: collection.name,
						setCode: collection.setCode,
						collectorNumber: collection.collectorNumber,
						foil: collection.foil,
						condition: collection.condition,
						quantity: collection.quantity,
						locationOverride: collection.locationOverride
					})
					.from(collection)
					.where(inArray(collection.name, deckCardNames))
					.orderBy(collection.name, collection.setCode, collection.collectorNumber)
			: [];

	// Batch-query committed real copies per card name across all decks.
	// availableQty = collQty - committed; used for "All Copies Used" vs "Not Owned" distinction.
	const committedRows =
		deckCardNames.length > 0
			? await db
					.select({
						collectionId: collection.id,
						name: collection.name,
						deckName: decks.name,
						committed: sql<number>`CAST(COUNT(${cardAssignments.id}) AS INTEGER)`
					})
					.from(cardAssignments)
					.innerJoin(collection, eq(cardAssignments.collectionId, collection.id))
					.innerJoin(decks, eq(cardAssignments.deckId, decks.id))
					.where(
						and(inArray(collection.name, deckCardNames), eq(cardAssignments.status, 'assigned'))
					)
					.groupBy(collection.id, collection.name, decks.name)
			: [];
	const committedByName: Record<string, number> = {};
	const committedByCollectionId = new Map<number, number>();
	const conflictDecksByName = new Map<string, Set<string>>();
	const decksByCollectionId = new Map<number, Set<string>>();
	for (const r of committedRows) {
		committedByName[r.name] = (committedByName[r.name] ?? 0) + r.committed;
		committedByCollectionId.set(
			r.collectionId,
			(committedByCollectionId.get(r.collectionId) ?? 0) + r.committed
		);
		if (!conflictDecksByName.has(r.name)) conflictDecksByName.set(r.name, new Set());
		conflictDecksByName.get(r.name)!.add(r.deckName);
		if (!decksByCollectionId.has(r.collectionId))
			decksByCollectionId.set(r.collectionId, new Set());
		decksByCollectionId.get(r.collectionId)!.add(r.deckName);
	}

	const collectionPrintingsByName = new Map<
		string,
		Array<(typeof collectionPrintingRows)[number] & { available: number; assignedDecks: string[] }>
	>();
	for (const printing of collectionPrintingRows) {
		const committed = committedByCollectionId.get(printing.id) ?? 0;
		const entry = {
			...printing,
			available: Math.max(0, printing.quantity - committed),
			assignedDecks: [...(decksByCollectionId.get(printing.id) ?? [])].sort((a, b) =>
				a.localeCompare(b)
			)
		};
		const printings = collectionPrintingsByName.get(printing.name) ?? [];
		printings.push(entry);
		collectionPrintingsByName.set(printing.name, printings);
	}

	const cardsWithFallback = cards.map((card) => ({
		...card,
		syncAddedQuantity: syncAdditionByDeckCard.get(card.dcId)?.quantity ?? 0,
		syncReturnCount: pendingByDeckCard.get(card.dcId)?.removeCount ?? 0,
		syncReturnAssignmentIds: pendingByDeckCard.get(card.dcId)?.returnAssignmentIds ?? [],
		fallbackImageUri: cardImageByName.get(card.cardName) ?? null,
		collQty: collQtyByName[card.cardName] ?? 0,
		availableQty: Math.max(
			0,
			(collQtyByName[card.cardName] ?? 0) - (committedByName[card.cardName] ?? 0)
		),
		conflictDecks: [...(conflictDecksByName.get(card.cardName) ?? [])].sort((a, b) =>
			a.localeCompare(b)
		),
		collectionPrintings: collectionPrintingsByName.get(card.cardName) ?? [],
		availableProxyInventory:
			availableProxyInventoryByName.get(card.cardName.toLocaleLowerCase()) ?? []
	}));

	for (const card of cardsWithFallback) {
		const board = card.board ?? 'main';
		if (!boardsFinal[board]) boardsFinal[board] = [];
		boardsFinal[board].push(card);
	}

	return {
		deck,
		boards: boardsFinal,
		deckCardsEnriched,
		pendingRemovals,
		syncAdditions: syncAdditionRows
	};
};

export const actions: Actions = {
	deleteDeck: async ({ params }) => {
		const deckId = parseInt(params.id);
		const packed = await packedAssignmentCount(deckId);
		if (packed > 0) {
			return fail(409, {
				error: `Unpack the ${packed} packed card${packed === 1 ? '' : 's'} before deleting this deck.`
			});
		}
		await db.delete(decks).where(eq(decks.id, deckId));
		redirect(303, '/decks');
	},

	archiveDeck: async ({ params }) => {
		const deckId = parseInt(params.id);
		const packed = await packedAssignmentCount(deckId);
		if (packed > 0) {
			return fail(409, {
				error: `Unpack the ${packed} packed card${packed === 1 ? '' : 's'} before archiving this deck.`
			});
		}
		// Unassign all cards on archive
		await db
			.update(cardAssignments)
			.set({ status: 'unassigned', collectionId: null, pulled: false, printStatus: null })
			.where(eq(cardAssignments.deckId, deckId));
		await db.update(decks).set({ archivedAt: Date.now() }).where(eq(decks.id, deckId));
		redirect(303, '/decks');
	},

	restoreDeck: async ({ params }) => {
		const deckId = parseInt(params.id);
		await db.update(decks).set({ archivedAt: null }).where(eq(decks.id, deckId));
		redirect(303, `/decks/${deckId}`);
	},

	updateDeck: async ({ params, request }) => {
		const deckId = parseInt(params.id);
		const [deck] = await db
			.select({ sourceMode: decks.sourceMode })
			.from(decks)
			.where(eq(decks.id, deckId))
			.limit(1);
		if (!deck) return fail(404, { error: 'Deck not found.' });
		if (deck.sourceMode === 'moxfield') {
			return fail(409, {
				error: 'Deck details are managed by Moxfield. Convert this deck to local editing first.'
			});
		}
		const data = await request.formData();
		const name = ((data.get('name') as string) ?? '').trim();
		const format = ((data.get('format') as string) ?? '').trim() || null;
		const commander = ((data.get('commander') as string) ?? '').trim() || null;
		const notes = ((data.get('notes') as string) ?? '').trim() || null;

		if (!name) return fail(400, { error: 'Name is required.' });

		await db
			.update(decks)
			.set({ name, format, commander, notes, updatedAt: Date.now() })
			.where(eq(decks.id, deckId));

		return { success: true };
	},

	resetAssignments: async ({ params }) => {
		const deckId = parseInt(params.id);
		const packed = await packedAssignmentCount(deckId);
		if (packed > 0) {
			return fail(409, {
				error: `Unpack the ${packed} packed card${packed === 1 ? '' : 's'} before resetting assignments.`
			});
		}
		await db
			.update(cardAssignments)
			.set({ status: 'unassigned', collectionId: null, pulled: false, printStatus: null })
			.where(eq(cardAssignments.deckId, deckId));
		return { success: true };
	},

	pullAll: async ({ params }) => {
		const deckId = parseInt(params.id);
		const mainDcIds = (
			await db
				.select({ id: deckCards.id })
				.from(deckCards)
				.where(and(eq(deckCards.deckId, deckId), inArray(deckCards.board, ['main', 'commander'])))
		).map((r) => r.id);
		if (mainDcIds.length === 0) return { success: true };
		// Pull all fulfilled cards. Real cards must be linked to a collection printing.
		await db
			.update(cardAssignments)
			.set({ pulled: true })
			.where(
				and(
					eq(cardAssignments.deckId, deckId),
					or(
						eq(cardAssignments.status, 'proxied'),
						and(eq(cardAssignments.status, 'assigned'), isNotNull(cardAssignments.collectionId))
					),
					inArray(cardAssignments.deckCardId, mainDcIds)
				)
			);
		return { success: true };
	},

	unPullAll: async ({ params }) => {
		const deckId = parseInt(params.id);
		const mainDcIds = (
			await db
				.select({ id: deckCards.id })
				.from(deckCards)
				.where(and(eq(deckCards.deckId, deckId), inArray(deckCards.board, ['main', 'commander'])))
		).map((r) => r.id);
		if (mainDcIds.length === 0) return { success: true };
		await db
			.update(cardAssignments)
			.set({ pulled: false })
			.where(
				and(
					eq(cardAssignments.deckId, deckId),
					eq(cardAssignments.pulled, true),
					inArray(cardAssignments.deckCardId, mainDcIds)
				)
			);
		return { success: true };
	},

	syncDeck: async ({ params }) => {
		const deckId = parseInt(params.id);
		try {
			const result = await syncOneDeck(deckId);
			return { syncResult: result };
		} catch (e) {
			return fail(500, { error: String(e) });
		}
	},

	convertToLocal: async ({ params }) => {
		const deckId = parseInt(params.id);
		await convertDeckToLocal(deckId);
		return { convertedToLocal: true };
	},

	resolvePendingRemoval: async ({ params, request }) => {
		const deckId = parseInt(params.id);
		const data = await request.formData();
		const pendingRemovalId = Number(data.get('pendingRemovalId'));
		const resolution = data.get('resolution');
		if (!Number.isInteger(pendingRemovalId) || pendingRemovalId <= 0) {
			return fail(400, { error: 'Invalid pending removal.' });
		}
		if (resolution !== 'apply' && resolution !== 'dismiss') {
			return fail(400, { error: 'Invalid pending-removal action.' });
		}
		try {
			if (resolution === 'apply') {
				await applyPendingRemoval(deckId, pendingRemovalId);
			} else {
				await dismissPendingRemoval(deckId, pendingRemovalId);
			}
			return { pendingRemovalResolved: resolution };
		} catch (cause) {
			return fail(409, {
				error: cause instanceof Error ? cause.message : 'Could not resolve pending removal.'
			});
		}
	},

	acknowledgeSyncAdditions: async ({ params }) => {
		const deckId = Number(params.id);
		if (!Number.isInteger(deckId) || deckId <= 0) {
			return fail(400, { error: 'Invalid deck.' });
		}
		await acknowledgeDeckSyncAdditions(deckId);
		return { syncAdditionsAcknowledged: true };
	},

	autoAssign: async ({ params }) => {
		const deckId = parseInt(params.id);
		// Find slots that need a collection copy assigned.
		// Exclude maybeboard cards — they are not part of the real deck.
		const unmatched = await db
			.select({
				id: cardAssignments.id,
				cardName: cardAssignments.cardName,
				status: cardAssignments.status
			})
			.from(cardAssignments)
			.innerJoin(deckCards, eq(cardAssignments.deckCardId, deckCards.id))
			.where(
				and(
					eq(cardAssignments.deckId, deckId),
					sql`${deckCards.board} != 'maybe'`,
					or(
						inArray(cardAssignments.status, ['unassigned', 'needed']),
						and(eq(cardAssignments.status, 'assigned'), isNull(cardAssignments.collectionId))
					)
				)
			);

		for (const assignment of unmatched) {
			const available = await db
				.select({
					id: collection.id,
					quantity: collection.quantity,
					locationOverride: collection.locationOverride
				})
				.from(collection)
				.where(eq(collection.name, assignment.cardName));

			for (const entry of available) {
				const [{ cnt }] = await db
					.select({ cnt: count() })
					.from(cardAssignments)
					.where(
						and(eq(cardAssignments.collectionId, entry.id), eq(cardAssignments.status, 'assigned'))
					);
				if (entry.quantity - cnt > 0) {
					const newStatus = 'assigned';
					await db
						.update(cardAssignments)
						.set({ collectionId: entry.id, status: newStatus })
						.where(eq(cardAssignments.id, assignment.id));
					break;
				}
			}
		}

		return { success: true };
	}
};
