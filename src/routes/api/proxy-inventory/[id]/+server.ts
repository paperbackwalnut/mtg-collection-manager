import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cardAssignments, proxyInventory } from '$lib/server/db/schema';
import {
	proxyInventoryDetailsError,
	proxyReleaseError,
	proxyReservationError
} from '$lib/server/proxy-inventory';
import { isCardLocation } from '$lib/types';

function inventoryId(value: string): number {
	const id = Number.parseInt(value, 10);
	if (!Number.isInteger(id) || id <= 0) error(400, 'Invalid proxy inventory id');
	return id;
}

function optionalText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	return value.trim() || null;
}

export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = inventoryId(params.id);
	let body: {
		action?: 'reserve' | 'update';
		assignmentId?: number | null;
		setCode?: string | null;
		collectorNumber?: string | null;
		location?: string;
		printState?: string;
		notes?: string | null;
	};
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON');
	}

	if (body.action === 'update') {
		const setCode = optionalText(body.setCode)?.toLocaleLowerCase() ?? null;
		const collectorNumber = optionalText(body.collectorNumber);
		const printState = body.printState ?? 'ready';
		const detailsError = proxyInventoryDetailsError({
			setCode,
			collectorNumber,
			printState
		});
		if (detailsError) error(400, detailsError);

		const location = body.location ?? 'proxy_box';
		if (!isCardLocation(location)) error(400, 'Invalid proxy location');

		const result = db.transaction((tx) => {
			const [copy] = tx
				.select()
				.from(proxyInventory)
				.where(eq(proxyInventory.id, id))
				.limit(1)
				.all();
			if (!copy) error(404, 'Printed proxy not found');

			const now = Date.now();
			const [updated] = tx
				.update(proxyInventory)
				.set({
					setCode,
					collectorNumber,
					location,
					printState,
					notes: optionalText(body.notes),
					updatedAt: now
				})
				.where(eq(proxyInventory.id, id))
				.returning()
				.all();

			const [assignment] = tx
				.select({ id: cardAssignments.id })
				.from(cardAssignments)
				.where(eq(cardAssignments.proxyInventoryId, id))
				.limit(1)
				.all();
			if (assignment) {
				tx.update(cardAssignments)
					.set({
						proxySetCode: setCode,
						proxyCollectorNumber: collectorNumber,
						printStatus: printState === 'needs_reprint' ? 'need_reprint' : null
					})
					.where(eq(cardAssignments.id, assignment.id))
					.run();
			}
			return updated;
		});

		return json(result);
	}

	if (!Number.isInteger(body.assignmentId) || (body.assignmentId ?? 0) <= 0) {
		error(400, 'A valid assignmentId is required');
	}
	const assignmentId = body.assignmentId as number;

	const result = db.transaction((tx) => {
		const [copy] = tx.select().from(proxyInventory).where(eq(proxyInventory.id, id)).limit(1).all();
		if (!copy) error(404, 'Printed proxy not found');

		const [currentLink] = tx
			.select({ id: cardAssignments.id })
			.from(cardAssignments)
			.where(eq(cardAssignments.proxyInventoryId, id))
			.limit(1)
			.all();
		if (currentLink) error(409, 'This printed proxy is already reserved');

		const [assignment] = tx
			.select()
			.from(cardAssignments)
			.where(eq(cardAssignments.id, assignmentId))
			.limit(1)
			.all();
		if (!assignment) error(404, 'Deck assignment not found');

		const reservationError = proxyReservationError(copy.cardName, assignment);
		if (reservationError) error(409, reservationError);

		const [updated] = tx
			.update(cardAssignments)
			.set({
				proxyInventoryId: id,
				proxySetCode: copy.setCode,
				proxyCollectorNumber: copy.collectorNumber,
				printStatus: copy.printState === 'needs_reprint' ? 'need_reprint' : null
			})
			.where(
				and(
					eq(cardAssignments.id, assignmentId),
					eq(cardAssignments.status, 'proxied'),
					isNull(cardAssignments.proxyInventoryId)
				)
			)
			.returning()
			.all();

		if (!updated) error(409, 'That assignment is no longer available');
		return updated;
	});

	return json(result);
};

export const DELETE: RequestHandler = async ({ params }) => {
	const id = inventoryId(params.id);

	const result = db.transaction((tx) => {
		const [copy] = tx
			.select({ id: proxyInventory.id })
			.from(proxyInventory)
			.where(eq(proxyInventory.id, id))
			.limit(1)
			.all();
		if (!copy) error(404, 'Printed proxy not found');

		const [assignment] = tx
			.select()
			.from(cardAssignments)
			.where(eq(cardAssignments.proxyInventoryId, id))
			.limit(1)
			.all();
		if (!assignment) error(409, 'This printed proxy is already available');

		const releaseError = proxyReleaseError(assignment.pulled);
		if (releaseError) error(409, releaseError);

		const [updated] = tx
			.update(cardAssignments)
			.set({
				proxyInventoryId: null,
				printStatus: 'need_print'
			})
			.where(and(eq(cardAssignments.id, assignment.id), eq(cardAssignments.proxyInventoryId, id)))
			.returning()
			.all();

		if (!updated) error(409, 'This printed proxy reservation changed; refresh and try again');
		return updated;
	});

	return json(result);
};
