import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/index';
import {
	cardAssignments,
	decks,
	deckCards,
	collection,
	proxyInventory
} from '$lib/server/db/schema';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { getByIds, getByName as scryfallByName } from '$lib/server/db/scryfall-sqlite';
import { BASIC_LAND_NAMES } from '$lib/basics';
import { computeLocation } from '$lib/server/location';
import { LOCATION_LABELS } from '$lib/types';
import type { CardLocation } from '$lib/types';
import { proxyInventoryAssignmentState } from '$lib/server/proxy-inventory';

export const load: PageServerLoad = async () => {
	// ── Proxied assignments ───────────────────────────────────────────────────
	const rows = await db
		.select({
			id: cardAssignments.id,
			cardName: cardAssignments.cardName,
			status: cardAssignments.status,
			deckId: cardAssignments.deckId,
			proxySetCode: cardAssignments.proxySetCode,
			proxyCollectorNumber: cardAssignments.proxyCollectorNumber,
			proxyInventoryId: cardAssignments.proxyInventoryId,
			printStatus: cardAssignments.printStatus,
			note: cardAssignments.note,
			deckName: decks.name,
			collSetCode: collection.setCode,
			collCollectorNumber: collection.collectorNumber,
			collScryfallId: collection.scryfallId
		})
		.from(cardAssignments)
		.innerJoin(decks, eq(cardAssignments.deckId, decks.id))
		.innerJoin(deckCards, eq(cardAssignments.deckCardId, deckCards.id))
		.leftJoin(collection, eq(cardAssignments.collectionId, collection.id))
		.where(
			and(
				eq(cardAssignments.status, 'proxied'),
				notInArray(cardAssignments.cardName, [...BASIC_LAND_NAMES]),
				sql`${deckCards.board} != 'maybe'`
			)
		)
		.orderBy(decks.name, cardAssignments.cardName);

	const sc = getByIds(rows.map((r) => r.collScryfallId));
	const enriched = rows.map((r) => ({
		...r,
		imageUri: (r.collScryfallId ? sc.get(r.collScryfallId)?.image_uri : null) ?? null
	}));

	// ── Physical printed-proxy inventory ─────────────────────────────────────
	const inventoryRecords = await db
		.select({
			id: proxyInventory.id,
			cardName: proxyInventory.cardName,
			setCode: proxyInventory.setCode,
			collectorNumber: proxyInventory.collectorNumber,
			location: proxyInventory.location,
			printState: proxyInventory.printState,
			notes: proxyInventory.notes,
			assignmentId: cardAssignments.id,
			pulled: cardAssignments.pulled,
			deckId: decks.id,
			deckName: decks.name
		})
		.from(proxyInventory)
		.leftJoin(cardAssignments, eq(cardAssignments.proxyInventoryId, proxyInventory.id))
		.leftJoin(decks, eq(cardAssignments.deckId, decks.id))
		.orderBy(proxyInventory.cardName, proxyInventory.setCode, proxyInventory.collectorNumber);

	const reservationCandidates = await db
		.select({
			assignmentId: cardAssignments.id,
			cardName: cardAssignments.cardName,
			deckId: decks.id,
			deckName: decks.name,
			printStatus: cardAssignments.printStatus
		})
		.from(cardAssignments)
		.innerJoin(decks, eq(cardAssignments.deckId, decks.id))
		.innerJoin(deckCards, eq(cardAssignments.deckCardId, deckCards.id))
		.where(
			and(
				eq(cardAssignments.status, 'proxied'),
				isNull(cardAssignments.proxyInventoryId),
				notInArray(cardAssignments.cardName, [...BASIC_LAND_NAMES]),
				sql`${deckCards.board} != 'maybe'`
			)
		)
		.orderBy(decks.name, cardAssignments.cardName);

	const candidatesByCard = new Map<string, typeof reservationCandidates>();
	for (const candidate of reservationCandidates) {
		const key = candidate.cardName.toLocaleLowerCase();
		if (!candidatesByCard.has(key)) candidatesByCard.set(key, []);
		candidatesByCard.get(key)!.push(candidate);
	}

	const inventory = inventoryRecords.map((record) => {
		const assignmentState = proxyInventoryAssignmentState(record.assignmentId, record.pulled);
		const location = record.location as CardLocation;
		return {
			...record,
			assignmentState,
			available: assignmentState === 'available',
			locationLabel: LOCATION_LABELS[location] ?? record.location,
			reservationOptions:
				assignmentState === 'available'
					? (candidatesByCard.get(record.cardName.toLocaleLowerCase()) ?? [])
					: []
		};
	});

	// Group by deck
	const byDeck = new Map<string, typeof enriched>();
	for (const row of enriched) {
		if (!byDeck.has(row.deckName)) byDeck.set(row.deckName, []);
		byDeck.get(row.deckName)!.push(row);
	}
	const groups = [...byDeck.entries()].map(([deck, items]) => ({ deck, items }));

	// ── "Where's the real card?" lookup ──────────────────────────────────────
	// For each unique proxied card name, find how many copies are owned and
	// where they are (location or which decks have them assigned/pulled).
	const proxyCardNames = [...new Set(rows.map((r) => r.cardName))];

	// 1. Collection entries for these card names
	const collEntries =
		proxyCardNames.length > 0
			? await db
					.select({
						id: collection.id,
						name: collection.name,
						quantity: collection.quantity,
						setCode: collection.setCode,
						collectorNumber: collection.collectorNumber,
						locationOverride: collection.locationOverride,
						scryfallId: collection.scryfallId
					})
					.from(collection)
					.where(inArray(collection.name, proxyCardNames))
			: [];

	// 2. Active (non-proxy) assignments for those collection IDs
	const collIds = collEntries.map((e) => e.id);
	const activeAssigns =
		collIds.length > 0
			? await db
					.select({
						collectionId: cardAssignments.collectionId,
						status: cardAssignments.status,
						pulled: cardAssignments.pulled,
						deckName: decks.name
					})
					.from(cardAssignments)
					.innerJoin(decks, eq(cardAssignments.deckId, decks.id))
					.where(
						and(
							inArray(cardAssignments.collectionId, collIds),
							eq(cardAssignments.status, 'assigned')
						)
					)
			: [];

	// Group collection entries and their assignments by card name
	const assignsByCollId = new Map<
		number,
		{ status: string; pulled: boolean; deckName: string }[]
	>();
	for (const a of activeAssigns) {
		if (!a.collectionId) continue;
		if (!assignsByCollId.has(a.collectionId)) assignsByCollId.set(a.collectionId, []);
		assignsByCollId
			.get(a.collectionId)!
			.push({ status: a.status, pulled: a.pulled ?? false, deckName: a.deckName });
	}

	// Build per-card-name real info
	// collBySc holds scryfall data for location computation
	const collSc = getByIds(collEntries.map((e) => e.scryfallId));

	type RealCardInfo =
		| { kind: 'not_owned' }
		| { kind: 'in_deck'; deckName: string; status: string; pulled: boolean }
		| { kind: 'in_collection'; location: string; qty: number };

	const realCardByName = new Map<string, RealCardInfo>();

	for (const name of proxyCardNames) {
		const entries = collEntries.filter((e) => e.name === name);
		if (entries.length === 0) {
			realCardByName.set(name, { kind: 'not_owned' });
			continue;
		}

		// Check if any copy is assigned to a deck
		const usedEntries = entries.flatMap((e) => {
			const assigns = assignsByCollId.get(e.id) ?? [];
			return assigns.map((a) => ({ ...a, entry: e }));
		});

		if (usedEntries.length > 0) {
			// Show the most "active" assignment (pulled > assigned)
			const best = usedEntries.sort((a, b) => (a.pulled ? 0 : 1) - (b.pulled ? 0 : 1))[0];
			realCardByName.set(name, {
				kind: 'in_deck',
				deckName: best.deckName,
				status: best.status,
				pulled: best.pulled
			});
			continue;
		}

		// No active deck assignments — card is sitting in a box/binder
		const totalQty = entries.reduce((s, e) => s + e.quantity, 0);
		const firstEntry = entries[0];
		const scData = firstEntry.scryfallId ? collSc.get(firstEntry.scryfallId) : undefined;
		const scFallback = scData ?? scryfallByName(name) ?? undefined;
		const location = computeLocation(
			scFallback?.type_line ?? '',
			scFallback?.mana_cost,
			scFallback?.price_usd,
			firstEntry.locationOverride
		) as CardLocation;
		const locationLabel = (LOCATION_LABELS as Record<string, string>)[location] ?? location;
		realCardByName.set(name, { kind: 'in_collection', location: locationLabel, qty: totalQty });
	}

	// Attach real card info to each row
	const realCardRows = rows.map((r) => ({
		assignmentId: r.id,
		cardName: r.cardName,
		deckName: r.deckName,
		note: r.note,
		realCard: realCardByName.get(r.cardName) ?? { kind: 'not_owned' as const }
	}));

	// Sort: not_owned first, then in_deck, then in_collection; alpha within
	realCardRows.sort((a, b) => {
		const order = { not_owned: 0, in_deck: 1, in_collection: 2 };
		const ko = (order[a.realCard.kind] ?? 3) - (order[b.realCard.kind] ?? 3);
		if (ko !== 0) return ko;
		return a.cardName.localeCompare(b.cardName);
	});

	return { groups, realCardRows, inventory };
};
