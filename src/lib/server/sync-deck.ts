/**
 * Transactional Moxfield synchronization for one deck.
 *
 * Network fetches and Scryfall enrichment happen before the SQLite
 * transaction. Once the transaction starts, the deck is advisory-locked,
 * every destructive change is preflighted, and all writes succeed or roll
 * back together.
 */

import { db } from '$lib/server/db/index';
import {
	decks,
	deckCards,
	cardAssignments,
	collection,
	deckPendingRemovals,
	deckPendingReturnAssignments,
	deckSyncAdditions
} from '$lib/server/db/schema';
import { eq, and, sql, count, inArray } from 'drizzle-orm';
import { fetchMoxfieldDeck } from '$lib/server/moxfield';
import { enrichByIdentifiers, enrichByName } from '$lib/server/scryfall';
import { getByName as scryfallByName } from '$lib/server/db/scryfall-sqlite';
import { planSyncRemovals } from '$lib/server/deck-sync-safety';

export type SyncResult = {
	added: number;
	removed: number;
	updated: number;
	pending: number;
};

export async function syncOneDeck(deckId: number): Promise<SyncResult> {
	const [storedDeck] = await db.select().from(decks).where(eq(decks.id, deckId)).limit(1);
	if (!storedDeck) throw new Error('Deck not found.');
	if (!storedDeck.moxfieldUrl) throw new Error('No Moxfield URL stored for this deck.');
	if (storedDeck.sourceMode !== 'moxfield') {
		throw new Error('This deck is locally managed and cannot be synced from Moxfield.');
	}

	let parsed: Awaited<ReturnType<typeof fetchMoxfieldDeck>>;
	try {
		parsed = await fetchMoxfieldDeck(storedDeck.moxfieldUrl);
	} catch (error) {
		const message = `Failed to fetch deck from Moxfield: ${error}`;
		await db
			.update(decks)
			.set({
				lastSyncAttemptedAt: Date.now(),
				lastSyncStatus: 'error',
				lastSyncError: message
			})
			.where(eq(decks.id, deckId));
		throw new Error(message, { cause: error });
	}

	// Populate local printing metadata before opening a remote DB transaction.
	const identifiers = parsed.cards
		.filter((card) => card.setCode && card.collectorNumber)
		.map((card) => ({
			setCode: card.setCode as string,
			collectorNumber: card.collectorNumber as string
		}));
	if (identifiers.length > 0) {
		await enrichByIdentifiers(identifiers).catch(() => null);
	}
	for (const card of parsed.cards) {
		if (!card.setCode || !card.collectorNumber) {
			if (!scryfallByName(card.cardName)) {
				await enrichByName(card.cardName).catch(() => null);
			}
		}
	}

	try {
		return db.transaction((tx) => {
			const currentDcRows = tx.select().from(deckCards).where(eq(deckCards.deckId, deckId)).all();

			const currentAssignments = tx
				.select({
					id: cardAssignments.id,
					deckCardId: cardAssignments.deckCardId,
					status: cardAssignments.status,
					pulled: cardAssignments.pulled,
					collectionId: cardAssignments.collectionId
				})
				.from(cardAssignments)
				.where(eq(cardAssignments.deckId, deckId))
				.all();

			const removalPlans = planSyncRemovals(currentDcRows, currentAssignments, parsed.cards);
			const removalPlanByDeckCard = new Map(removalPlans.map((plan) => [plan.deckCardId, plan]));

			const assignmentsByDcId = new Map<number, typeof currentAssignments>();
			for (const assignment of currentAssignments) {
				const rows = assignmentsByDcId.get(assignment.deckCardId) ?? [];
				rows.push(assignment);
				assignmentsByDcId.set(assignment.deckCardId, rows);
			}

			const oldByNameBoard = new Map(
				currentDcRows.map((card) => [`${card.cardName}:::${card.board ?? 'main'}`, card])
			);
			const oldByName = new Map(currentDcRows.map((card) => [card.cardName, card]));
			const matchedOldIds = new Set<number>();
			let cardsAdded = 0;
			let cardsRemoved = 0;
			let cardsUpdated = 0;

			function recordAddition(
				deckCardId: number,
				cardName: string,
				board: string,
				quantity: number
			) {
				if (quantity <= 0) return;
				const now = Date.now();
				tx.insert(deckSyncAdditions)
					.values({
						deckId,
						deckCardId,
						cardName,
						board,
						quantity,
						detectedAt: now,
						updatedAt: now
					})
					.onConflictDoUpdate({
						target: deckSyncAdditions.deckCardId,
						set: {
							cardName,
							board,
							quantity: sql`${deckSyncAdditions.quantity} + ${quantity}`,
							updatedAt: now
						}
					})
					.run();
			}

			function recordPendingRemoval(
				deckCardId: number,
				cardName: string,
				board: string,
				targetQuantity: number,
				assignmentIds: number[]
			) {
				const now = Date.now();
				const [pending] = tx
					.insert(deckPendingRemovals)
					.values({
						deckId,
						deckCardId,
						cardName,
						board,
						targetQuantity,
						detectedAt: now,
						updatedAt: now
					})
					.onConflictDoUpdate({
						target: deckPendingRemovals.deckCardId,
						set: { cardName, board, targetQuantity, updatedAt: now }
					})
					.returning({ id: deckPendingRemovals.id })
					.all();

				tx.delete(deckPendingReturnAssignments)
					.where(eq(deckPendingReturnAssignments.pendingRemovalId, pending.id))
					.run();
				if (assignmentIds.length > 0) {
					tx.insert(deckPendingReturnAssignments)
						.values(
							assignmentIds.map((assignmentId) => ({
								pendingRemovalId: pending.id,
								assignmentId,
								detectedAt: now
							}))
						)
						.run();
				}
			}

			function reduceUnreviewedAddition(deckCardId: number, quantity: number) {
				if (quantity <= 0) return;
				tx.delete(deckSyncAdditions)
					.where(
						and(
							eq(deckSyncAdditions.deckCardId, deckCardId),
							sql`${deckSyncAdditions.quantity} <= ${quantity}`
						)
					)
					.run();
				tx.update(deckSyncAdditions)
					.set({
						quantity: sql`${deckSyncAdditions.quantity} - ${quantity}`,
						updatedAt: Date.now()
					})
					.where(eq(deckSyncAdditions.deckCardId, deckCardId))
					.run();
			}

			function insertAssignment(
				deckCardId: number,
				cardName: string,
				setCode: string | null | undefined,
				collectorNumber: string | null | undefined,
				board = 'main'
			) {
				if (board === 'maybe') {
					tx.insert(cardAssignments)
						.values({
							deckCardId,
							deckId,
							cardName,
							collectionId: null,
							status: 'unassigned',
							proxySetCode: null,
							proxyCollectorNumber: null
						})
						.run();
					return;
				}

				let collectionId: number | null = null;
				let status = 'unassigned';
				if (setCode && collectorNumber) {
					const entries = tx
						.select({
							id: collection.id,
							quantity: collection.quantity,
							locationOverride: collection.locationOverride
						})
						.from(collection)
						.where(
							and(
								eq(collection.name, cardName),
								eq(collection.setCode, setCode),
								eq(collection.collectorNumber, collectorNumber)
							)
						)
						.limit(10)
						.all();

					for (const entry of entries) {
						const [{ cnt }] = tx
							.select({ cnt: count() })
							.from(cardAssignments)
							.where(
								and(
									eq(cardAssignments.collectionId, entry.id),
									eq(cardAssignments.status, 'assigned')
								)
							)
							.all();
						if (entry.quantity - cnt > 0) {
							collectionId = entry.id;
							status = 'assigned';
							break;
						}
					}
				}

				tx.insert(cardAssignments)
					.values({
						deckCardId,
						deckId,
						cardName,
						collectionId,
						status,
						proxySetCode: null,
						proxyCollectorNumber: null
					})
					.run();
			}

			for (const incoming of parsed.cards) {
				const exactKey = `${incoming.cardName}:::${incoming.board}`;
				let current = oldByNameBoard.get(exactKey);
				let movedBoard = false;

				if (!current) {
					const sameName = oldByName.get(incoming.cardName);
					if (sameName && !matchedOldIds.has(sameName.id)) {
						current = sameName;
						movedBoard = true;
					}
				}

				if (current) {
					matchedOldIds.add(current.id);
					const oldSlots = assignmentsByDcId.get(current.id) ?? [];
					const quantityDiff = incoming.quantity - oldSlots.length;
					const removalPlan = removalPlanByDeckCard.get(current.id);
					const nextQuantity = removalPlan?.remainingQuantity ?? incoming.quantity;

					tx.update(deckCards)
						.set({
							quantity: nextQuantity,
							setCode: incoming.setCode ?? null,
							collectorNumber: incoming.collectorNumber ?? null,
							isCommander: incoming.isCommander,
							...(movedBoard ? { board: incoming.board } : {})
						})
						.where(eq(deckCards.id, current.id))
						.run();
					cardsUpdated++;

					if (quantityDiff > 0) {
						for (let index = 0; index < quantityDiff; index++) {
							insertAssignment(
								current.id,
								incoming.cardName,
								incoming.setCode,
								incoming.collectorNumber,
								incoming.board
							);
						}
						recordAddition(current.id, incoming.cardName, incoming.board, quantityDiff);
					} else if (quantityDiff < 0) {
						if (removalPlan && removalPlan.removeIds.length > 0) {
							tx.delete(cardAssignments)
								.where(inArray(cardAssignments.id, removalPlan.removeIds))
								.run();
						}
						reduceUnreviewedAddition(current.id, Math.abs(quantityDiff));
					}

					if (removalPlan && removalPlan.remainingQuantity > removalPlan.targetQuantity) {
						recordPendingRemoval(
							current.id,
							current.cardName,
							incoming.board,
							removalPlan.targetQuantity,
							removalPlan.protectedAssignments.map((assignment) => assignment.id)
						);
					} else {
						tx.delete(deckPendingRemovals)
							.where(eq(deckPendingRemovals.deckCardId, current.id))
							.run();
					}
				} else {
					const [newCard] = tx
						.insert(deckCards)
						.values({
							deckId,
							cardName: incoming.cardName,
							quantity: incoming.quantity,
							setCode: incoming.setCode ?? null,
							collectorNumber: incoming.collectorNumber ?? null,
							board: incoming.board,
							isCommander: incoming.isCommander
						})
						.returning()
						.all();

					for (let index = 0; index < incoming.quantity; index++) {
						insertAssignment(
							newCard.id,
							incoming.cardName,
							incoming.setCode,
							incoming.collectorNumber,
							incoming.board
						);
					}
					recordAddition(newCard.id, incoming.cardName, incoming.board, incoming.quantity);
					cardsAdded++;
				}
			}

			const unmatched = currentDcRows.filter((card) => !matchedOldIds.has(card.id));
			for (const card of unmatched) {
				const removalPlan = removalPlanByDeckCard.get(card.id);
				if (removalPlan?.removeIds.length) {
					tx.delete(cardAssignments)
						.where(inArray(cardAssignments.id, removalPlan.removeIds))
						.run();
				}

				if (removalPlan && removalPlan.remainingQuantity > 0) {
					tx.update(deckCards)
						.set({ quantity: removalPlan.remainingQuantity })
						.where(eq(deckCards.id, card.id))
						.run();
					recordPendingRemoval(
						card.id,
						card.cardName,
						card.board ?? 'main',
						0,
						removalPlan.protectedAssignments.map((assignment) => assignment.id)
					);
				} else {
					tx.delete(deckCards).where(eq(deckCards.id, card.id)).run();
					cardsRemoved++;
				}
			}

			const commanderCards = tx
				.select({ cardName: deckCards.cardName })
				.from(deckCards)
				.where(and(eq(deckCards.deckId, deckId), eq(deckCards.isCommander, true)))
				.all();
			const commander = commanderCards.map((card) => card.cardName).join(' / ') || parsed.commander;

			const [{ pendingCount }] = tx
				.select({
					pendingCount: sql<number>`CAST(COUNT(${deckPendingRemovals.id}) AS INTEGER)`
				})
				.from(deckPendingRemovals)
				.where(eq(deckPendingRemovals.deckId, deckId))
				.all();
			const syncedAt = Date.now();

			tx.update(decks)
				.set({
					name: parsed.name,
					format: parsed.format ?? null,
					commander: commander ?? null,
					lastSyncAttemptedAt: syncedAt,
					lastSyncedAt: syncedAt,
					lastSyncStatus: pendingCount > 0 ? 'pending' : 'success',
					lastSyncError: null,
					updatedAt: syncedAt
				})
				.where(eq(decks.id, deckId))
				.run();

			return {
				added: cardsAdded,
				removed: cardsRemoved,
				updated: cardsUpdated,
				pending: pendingCount
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(decks)
			.set({
				lastSyncAttemptedAt: Date.now(),
				lastSyncStatus: 'error',
				lastSyncError: message
			})
			.where(eq(decks.id, deckId))
			.catch(() => undefined);
		throw error;
	}
}
