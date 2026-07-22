import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db/index';
import { cardAssignments, collection, decks } from '$lib/server/db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { nextProxyPrintStatus } from '$lib/server/proxy-inventory';
import { isWritableAssignmentStatus } from '$lib/server/assignment-status';

function canPullAssignment(status: string, collectionId: number | null): boolean {
	return status === 'proxied' || (status === 'assigned' && collectionId !== null);
}

export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = parseInt(params.id);
	if (isNaN(id)) error(400, 'Invalid id');

	let body: {
		status?: string;
		pulled?: boolean;
		collectionId?: number | null;
		proxySetCode?: string;
		proxyCollectorNumber?: string;
		note?: string | null;
		printStatus?: string | null;
		override?: boolean;
		proxifyConflicts?: boolean;
	};
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON');
	}

	const {
		status,
		pulled,
		collectionId,
		proxySetCode,
		proxyCollectorNumber,
		note,
		printStatus,
		override,
		proxifyConflicts
	} = body;

	if (status && !isWritableAssignmentStatus(status)) {
		error(400, `Invalid status: ${status}`);
	}

	const [existing] = await db
		.select()
		.from(cardAssignments)
		.where(eq(cardAssignments.id, id))
		.limit(1);

	if (!existing) error(404, 'Assignment not found');

	const updates: Partial<typeof cardAssignments.$inferInsert> = {};

	if (status) updates.status = status;

	// Handle pulled flag
	if (pulled !== undefined) {
		const effectiveStatus = status ?? existing.status;
		const effectiveCollectionId = collectionId !== undefined ? collectionId : existing.collectionId;
		if (pulled && !canPullAssignment(effectiveStatus, effectiveCollectionId)) {
			error(400, `Cannot pull '${effectiveStatus}' without a linked printing or proxy status`);
		}
		updates.pulled = pulled;
		// Unpulling is always valid — just set pulled=false
	}

	if (collectionId !== undefined) {
		if (collectionId !== null) {
			const [entry] = await db
				.select({ quantity: collection.quantity })
				.from(collection)
				.where(eq(collection.id, collectionId))
				.limit(1);

			if (!entry) error(404, 'Collection entry not found');

			// Conflict = another assignment using this collection copy as a real card.
			const conflicting = await db
				.select({ id: cardAssignments.id })
				.from(cardAssignments)
				.where(
					and(
						eq(cardAssignments.collectionId, collectionId),
						eq(cardAssignments.status, 'assigned'),
						sql`${cardAssignments.id} != ${id}`
					)
				);

			const available = entry.quantity - conflicting.length;

			if (available <= 0) {
				if (!override) {
					error(409, 'No copies available in this collection entry');
				}
				if (conflicting.length > 0) {
					await db
						.update(cardAssignments)
						.set({
							status: proxifyConflicts ? 'proxied' : 'unassigned',
							collectionId: null,
							pulled: false,
							printStatus: proxifyConflicts ? 'need_print' : null
						})
						.where(
							inArray(
								cardAssignments.id,
								conflicting.map((c) => c.id)
							)
						);
				}
			}
		}
		updates.collectionId = collectionId;
	}

	if (proxySetCode !== undefined) updates.proxySetCode = proxySetCode ?? null;
	if (proxyCollectorNumber !== undefined)
		updates.proxyCollectorNumber = proxyCollectorNumber ?? null;
	if (note !== undefined) updates.note = note?.trim() || null;
	if (status !== undefined || printStatus !== undefined) {
		updates.printStatus = nextProxyPrintStatus({
			currentStatus: existing.status,
			currentPrintStatus: existing.printStatus,
			hasInventory: existing.proxyInventoryId !== null,
			nextStatus: status ?? existing.status,
			requestedPrintStatus: printStatus
		});
	}

	// Changing fulfillment type: clear collection link and pulled state for non-collection statuses
	if (status === 'proxied') {
		if (collectionId === undefined) updates.collectionId = null;
		// Don't auto-clear pulled — the user might be converting a pulled assigned card to a proxy in place
	}
	if (status === 'unassigned' || status === 'needed' || status === 'ordered') {
		updates.collectionId = null;
		updates.pulled = false;
		updates.proxySetCode = null;
		updates.proxyCollectorNumber = null;
	}

	await db.update(cardAssignments).set(updates).where(eq(cardAssignments.id, id));

	const [updated] = await db
		.select()
		.from(cardAssignments)
		.where(eq(cardAssignments.id, id))
		.limit(1);

	return json(updated);
};

// GET — available collection copies for the assign modal
export const GET: RequestHandler = async ({ params }) => {
	const id = parseInt(params.id);
	if (isNaN(id)) error(400, 'Invalid id');

	const [assignment] = await db
		.select()
		.from(cardAssignments)
		.where(eq(cardAssignments.id, id))
		.limit(1);

	if (!assignment) error(404, 'Not found');

	const entries = await db
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
		.where(eq(collection.name, assignment.cardName));

	if (entries.length === 0) return json([]);

	const entryIds = entries.map((e) => e.id);
	const conflictRows = await db
		.select({
			collectionId: cardAssignments.collectionId,
			assignmentId: cardAssignments.id,
			status: cardAssignments.status,
			deckName: decks.name
		})
		.from(cardAssignments)
		.innerJoin(decks, eq(cardAssignments.deckId, decks.id))
		.where(
			and(
				inArray(cardAssignments.collectionId, entryIds),
				eq(cardAssignments.status, 'assigned'),
				sql`${cardAssignments.id} != ${id}`
			)
		);

	const conflictMap = new Map<
		number,
		{ assignmentId: number; deckName: string; status: string }[]
	>();
	for (const row of conflictRows) {
		if (!row.collectionId) continue;
		if (!conflictMap.has(row.collectionId)) conflictMap.set(row.collectionId, []);
		conflictMap.get(row.collectionId)!.push({
			assignmentId: row.assignmentId,
			deckName: row.deckName,
			status: row.status
		});
	}

	const result = entries.map((entry) => {
		const conflicts = conflictMap.get(entry.id) ?? [];
		return {
			...entry,
			available: entry.quantity - conflicts.length,
			conflicts
		};
	});

	return json(result);
};
