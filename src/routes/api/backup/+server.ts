import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/index';
import {
	cardAssignments,
	collection,
	deckCards,
	deckPendingRemovals,
	deckPendingReturnAssignments,
	deckSyncAdditions,
	decks,
	orders,
	proxyInventory,
	shoppingList
} from '$lib/server/db/schema';
import { CURRENT_BACKUP_VERSION } from '$lib/server/backup-format';

export const GET: RequestHandler = async () => {
	const [
		collectionRows,
		decksRows,
		deckCardsRows,
		ordersRows,
		shoppingListRows,
		proxyInventoryRows,
		assignmentsRows,
		pendingRemovalRows,
		pendingReturnRows,
		syncAdditionRows
	] = await Promise.all([
		db.select().from(collection),
		db.select().from(decks),
		db.select().from(deckCards),
		db.select().from(orders),
		db.select().from(shoppingList),
		db.select().from(proxyInventory),
		db.select().from(cardAssignments),
		db.select().from(deckPendingRemovals),
		db.select().from(deckPendingReturnAssignments),
		db.select().from(deckSyncAdditions)
	]);

	const backup = {
		version: CURRENT_BACKUP_VERSION,
		exportedAt: new Date().toISOString(),
		collection: collectionRows,
		decks: decksRows,
		deckCards: deckCardsRows,
		orders: ordersRows,
		shoppingList: shoppingListRows,
		proxyInventory: proxyInventoryRows,
		cardAssignments: assignmentsRows,
		deckPendingRemovals: pendingRemovalRows,
		deckPendingReturnAssignments: pendingReturnRows,
		deckSyncAdditions: syncAdditionRows
	};

	const filename = `mtg-backup-${new Date().toISOString().slice(0, 10)}.json`;

	return new Response(JSON.stringify(backup, null, 2), {
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="${filename}"`
		}
	});
};
