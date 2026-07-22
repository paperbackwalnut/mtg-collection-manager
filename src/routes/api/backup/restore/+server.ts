import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
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
import { invalidateCollectionSearchCandidates } from '$lib/server/collection-search-candidates';
import {
	CURRENT_BACKUP_VERSION,
	hasRequiredProxyInventoryData,
	hasRequiredShoppingListData
} from '$lib/server/backup-format';

const CHUNK = 500; // rows per INSERT batch

function chunks<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

export const POST: RequestHandler = async ({ request }) => {
	let backup: {
		version: number;
		collection: (typeof collection.$inferInsert)[];
		decks: (typeof decks.$inferInsert)[];
		deckCards: (typeof deckCards.$inferInsert)[];
		orders: (typeof orders.$inferInsert)[];
		shoppingList?: (typeof shoppingList.$inferInsert)[];
		proxyInventory?: (typeof proxyInventory.$inferInsert)[];
		cardAssignments: (typeof cardAssignments.$inferInsert)[];
		deckPendingRemovals?: (typeof deckPendingRemovals.$inferInsert)[];
		deckPendingReturnAssignments?: (typeof deckPendingReturnAssignments.$inferInsert)[];
		deckSyncAdditions?: (typeof deckSyncAdditions.$inferInsert)[];
	};

	try {
		const text = await request.text();
		backup = JSON.parse(text);
	} catch {
		error(400, 'Invalid JSON');
	}

	if (
		!Number.isInteger(backup.version) ||
		backup.version < 1 ||
		backup.version > CURRENT_BACKUP_VERSION ||
		!Array.isArray(backup.collection) ||
		!Array.isArray(backup.decks) ||
		!Array.isArray(backup.deckCards) ||
		!Array.isArray(backup.orders) ||
		!Array.isArray(backup.cardAssignments)
	) {
		error(400, 'Unrecognised backup format');
	}
	const returnArrays = [
		backup.deckPendingRemovals,
		backup.deckPendingReturnAssignments,
		backup.deckSyncAdditions
	];
	const hasReturnData = returnArrays.every(Array.isArray);
	if (backup.version >= 4 && !hasReturnData) {
		error(400, 'Incomplete deck return backup data');
	}
	const hasProxyInventoryData = Array.isArray(backup.proxyInventory);
	if (!hasRequiredProxyInventoryData(backup.version, backup.proxyInventory)) {
		error(400, 'Incomplete proxy inventory backup data');
	}
	const hasShoppingListData = Array.isArray(backup.shoppingList);
	if (!hasRequiredShoppingListData(backup.version, backup.shoppingList)) {
		error(400, 'Incomplete shopping list backup data');
	}

	// Run everything in a transaction so a partial restore never happens
	db.transaction((tx) => {
		// 1. Wipe in reverse FK order
		tx.delete(deckPendingReturnAssignments).run();
		tx.delete(deckSyncAdditions).run();
		tx.delete(deckPendingRemovals).run();
		tx.delete(cardAssignments).run();
		tx.delete(proxyInventory).run();
		tx.delete(deckCards).run();
		tx.delete(decks).run();
		tx.delete(orders).run();
		tx.delete(shoppingList).run();
		tx.delete(collection).run();

		// 2. Re-insert in FK order, batched
		for (const batch of chunks(backup.collection, CHUNK)) {
			tx.insert(collection).values(batch).run();
		}
		for (const batch of chunks(backup.decks, CHUNK)) {
			tx.insert(decks).values(batch).run();
		}
		for (const batch of chunks(backup.orders, CHUNK)) {
			tx.insert(orders).values(batch).run();
		}
		if (hasShoppingListData) {
			for (const batch of chunks(backup.shoppingList!, CHUNK)) {
				tx.insert(shoppingList).values(batch).run();
			}
		}
		for (const batch of chunks(backup.deckCards, CHUNK)) {
			tx.insert(deckCards).values(batch).run();
		}
		if (hasProxyInventoryData) {
			for (const batch of chunks(backup.proxyInventory!, CHUNK)) {
				tx.insert(proxyInventory).values(batch).run();
			}
		}
		for (const batch of chunks(backup.cardAssignments, CHUNK)) {
			tx.insert(cardAssignments).values(batch).run();
		}
		if (hasReturnData) {
			for (const batch of chunks(backup.deckPendingRemovals!, CHUNK)) {
				tx.insert(deckPendingRemovals).values(batch).run();
			}
			for (const batch of chunks(backup.deckPendingReturnAssignments!, CHUNK)) {
				tx.insert(deckPendingReturnAssignments).values(batch).run();
			}
			for (const batch of chunks(backup.deckSyncAdditions!, CHUNK)) {
				tx.insert(deckSyncAdditions).values(batch).run();
			}
		}
	});

	// SQLite advances AUTOINCREMENT state when explicit restored IDs are inserted.
	invalidateCollectionSearchCandidates();

	return json({
		ok: true,
		restored: {
			collection: backup.collection.length,
			decks: backup.decks.length,
			deckCards: backup.deckCards.length,
			orders: backup.orders.length,
			...(hasShoppingListData
				? {
						shoppingList: backup.shoppingList!.length
					}
				: {}),
			...(hasProxyInventoryData
				? {
						proxyInventory: backup.proxyInventory!.length
					}
				: {}),
			cardAssignments: backup.cardAssignments.length,
			...(hasReturnData
				? {
						deckPendingRemovals: backup.deckPendingRemovals!.length,
						deckPendingReturnAssignments: backup.deckPendingReturnAssignments!.length,
						deckSyncAdditions: backup.deckSyncAdditions!.length
					}
				: {})
		}
	});
};
