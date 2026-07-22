import { db } from './db';
import {
	cardAssignments,
	collection,
	deckCards,
	deckPendingRemovals,
	deckPendingReturnAssignments,
	deckSyncAdditions,
	decks
} from './db/schema';
import { selectAssignmentsForPendingRemoval } from './deck-mutation-rules';
import {
	normalizePendingRemovalRequests,
	ownedCollectionIdsForReturn,
	PendingRemovalError,
	type PendingRemovalRequest
} from './deck-return-rules';
import { eq, inArray, sql } from 'drizzle-orm';

type DeckWorkspaceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export { PendingRemovalError } from './deck-return-rules';

export async function convertDeckToLocal(deckId: number): Promise<void> {
	db.transaction((tx) => {
		const [deck] = tx
			.select({ id: decks.id })
			.from(decks)
			.where(eq(decks.id, deckId))
			.limit(1)
			.all();
		if (!deck) throw new Error('Deck not found.');

		tx.update(decks)
			.set({
				sourceMode: 'local',
				lastSyncStatus: null,
				lastSyncError: null,
				updatedAt: Date.now()
			})
			.where(eq(decks.id, deckId))
			.run();
		tx.delete(deckPendingRemovals).where(eq(deckPendingRemovals.deckId, deckId)).run();
		tx.delete(deckSyncAdditions).where(eq(deckSyncAdditions.deckId, deckId)).run();
	});
}

export async function acknowledgeDeckSyncAdditions(deckId: number): Promise<void> {
	await db.delete(deckSyncAdditions).where(eq(deckSyncAdditions.deckId, deckId));
}

export async function dismissPendingRemoval(
	deckId: number,
	pendingRemovalId: number
): Promise<void> {
	db.transaction((tx) => {
		const removed = tx
			.delete(deckPendingRemovals)
			.where(eq(deckPendingRemovals.id, pendingRemovalId))
			.returning({ deckId: deckPendingRemovals.deckId })
			.all();
		if (removed.length === 0 || removed[0].deckId !== deckId) {
			throw new PendingRemovalError('Pending removal not found.', 'not_found');
		}

		const [{ count }] = tx
			.select({
				count: sql<number>`CAST(COUNT(${deckPendingRemovals.id}) AS INTEGER)`
			})
			.from(deckPendingRemovals)
			.where(eq(deckPendingRemovals.deckId, deckId))
			.all();
		if (count === 0) {
			tx.update(decks)
				.set({ lastSyncStatus: 'success', updatedAt: Date.now() })
				.where(eq(decks.id, deckId))
				.run();
		}
	});
}

function applyPendingRemovalInTransaction(
	tx: DeckWorkspaceTransaction,
	deckId: number,
	pendingRemovalId: number
): void {
	const [pending] = tx
		.select()
		.from(deckPendingRemovals)
		.where(eq(deckPendingRemovals.id, pendingRemovalId))
		.limit(1)
		.all();
	if (!pending || pending.deckId !== deckId) {
		throw new PendingRemovalError('Pending removal not found.', 'not_found');
	}

	const assignments = tx
		.select({
			id: cardAssignments.id,
			status: cardAssignments.status,
			pulled: cardAssignments.pulled,
			collectionId: cardAssignments.collectionId
		})
		.from(cardAssignments)
		.where(eq(cardAssignments.deckCardId, pending.deckCardId))
		.all();

	if (assignments.length <= pending.targetQuantity) {
		tx.delete(deckPendingRemovals).where(eq(deckPendingRemovals.id, pending.id)).run();
		const [{ count }] = tx
			.select({
				count: sql<number>`CAST(COUNT(${deckPendingRemovals.id}) AS INTEGER)`
			})
			.from(deckPendingRemovals)
			.where(eq(deckPendingRemovals.deckId, deckId))
			.all();
		tx.update(decks)
			.set({
				lastSyncStatus: count > 0 ? 'pending' : 'success',
				updatedAt: Date.now()
			})
			.where(eq(decks.id, deckId))
			.run();
		return;
	}

	const removeCount = assignments.length - pending.targetQuantity;
	const exactReturns = tx
		.select({ assignmentId: deckPendingReturnAssignments.assignmentId })
		.from(deckPendingReturnAssignments)
		.where(eq(deckPendingReturnAssignments.pendingRemovalId, pending.id))
		.all();
	const assignmentIds = new Set(assignments.map((assignment) => assignment.id));
	const exactIds = exactReturns
		.map((row) => row.assignmentId)
		.filter((assignmentId) => assignmentIds.has(assignmentId));
	if (exactReturns.length > 0 && exactIds.length !== removeCount) {
		throw new PendingRemovalError(
			'This return task changed unexpectedly. Sync the deck again before completing it.',
			'stale'
		);
	}
	const removeIds =
		exactReturns.length > 0
			? exactIds
			: selectAssignmentsForPendingRemoval(assignments, removeCount);
	const returnedCollectionIds = ownedCollectionIdsForReturn(assignments, removeIds);

	tx.delete(deckPendingReturnAssignments)
		.where(eq(deckPendingReturnAssignments.pendingRemovalId, pending.id))
		.run();
	if (returnedCollectionIds.length > 0) {
		tx.update(collection)
			.set({ locationOverride: 'holding_box' })
			.where(inArray(collection.id, returnedCollectionIds))
			.run();
	}
	tx.delete(cardAssignments).where(inArray(cardAssignments.id, removeIds)).run();

	if (pending.targetQuantity === 0) {
		tx.delete(deckCards).where(eq(deckCards.id, pending.deckCardId)).run();
	} else {
		tx.update(deckCards)
			.set({ quantity: pending.targetQuantity })
			.where(eq(deckCards.id, pending.deckCardId))
			.run();
		tx.delete(deckPendingRemovals).where(eq(deckPendingRemovals.id, pending.id)).run();
	}

	const [{ count }] = tx
		.select({
			count: sql<number>`CAST(COUNT(${deckPendingRemovals.id}) AS INTEGER)`
		})
		.from(deckPendingRemovals)
		.where(eq(deckPendingRemovals.deckId, deckId))
		.all();
	tx.update(decks)
		.set({
			lastSyncStatus: count > 0 ? 'pending' : 'success',
			updatedAt: Date.now()
		})
		.where(eq(decks.id, deckId))
		.run();
}

export async function applyPendingRemovals(requests: PendingRemovalRequest[]): Promise<number> {
	const uniqueRequests = normalizePendingRemovalRequests(requests);
	if (uniqueRequests.length === 0) return 0;

	db.transaction((tx) => {
		for (const request of uniqueRequests) {
			applyPendingRemovalInTransaction(tx, request.deckId, request.pendingRemovalId);
		}
	});
	return uniqueRequests.length;
}

export async function applyPendingRemoval(deckId: number, pendingRemovalId: number): Promise<void> {
	await applyPendingRemovals([{ deckId, pendingRemovalId }]);
}
