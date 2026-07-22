import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cardAssignments, proxyInventory } from '$lib/server/db/schema';
import { getByName, getBySetColl } from '$lib/server/db/scryfall-sqlite';
import { proxyInventoryDetailsError } from '$lib/server/proxy-inventory';
import { isCardLocation } from '$lib/types';

type CreateBody = {
	assignmentId?: number;
	cardName?: string;
	setCode?: string | null;
	collectorNumber?: string | null;
	location?: string;
	printState?: string;
	notes?: string | null;
};

function optionalText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	return value.trim() || null;
}

export const POST: RequestHandler = async ({ request }) => {
	let body: CreateBody;
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON');
	}

	if (body.assignmentId !== undefined) {
		if (!Number.isInteger(body.assignmentId) || body.assignmentId <= 0) {
			error(400, 'Invalid assignmentId');
		}
		const assignmentId = body.assignmentId;

		const result = db.transaction((tx) => {
			const [assignment] = tx
				.select()
				.from(cardAssignments)
				.where(eq(cardAssignments.id, assignmentId))
				.limit(1)
				.all();
			if (!assignment) error(404, 'Deck assignment not found');
			if (assignment.status !== 'proxied') {
				error(409, 'Only proxy assignments can create printed proxy inventory');
			}

			const now = Date.now();
			if (assignment.proxyInventoryId !== null) {
				const [updatedCopy] = tx
					.update(proxyInventory)
					.set({ printState: 'ready', updatedAt: now })
					.where(eq(proxyInventory.id, assignment.proxyInventoryId))
					.returning()
					.all();
				if (!updatedCopy) error(409, 'Linked printed proxy no longer exists');

				tx.update(cardAssignments)
					.set({ printStatus: null })
					.where(eq(cardAssignments.id, assignment.id))
					.run();
				return updatedCopy;
			}

			const nameMatch = getByName(assignment.cardName);
			const printingMatch =
				assignment.proxySetCode && assignment.proxyCollectorNumber
					? getBySetColl(assignment.proxySetCode, assignment.proxyCollectorNumber)
					: nameMatch;
			const [created] = tx
				.insert(proxyInventory)
				.values({
					cardName: assignment.cardName,
					oracleId: printingMatch?.oracle_id ?? nameMatch?.oracle_id ?? null,
					scryfallId: printingMatch?.id ?? null,
					setCode: assignment.proxySetCode,
					collectorNumber: assignment.proxyCollectorNumber,
					location: 'proxy_box',
					printState: 'ready',
					notes: assignment.note,
					createdAt: now,
					updatedAt: now
				})
				.returning()
				.all();

			const [linked] = tx
				.update(cardAssignments)
				.set({
					proxyInventoryId: created.id,
					printStatus: null
				})
				.where(eq(cardAssignments.id, assignment.id))
				.returning()
				.all();
			if (!linked?.proxyInventoryId) {
				error(409, 'The new printed proxy could not be linked to its assignment');
			}
			return created;
		});

		return json(result, { status: 201 });
	}

	const cardName = optionalText(body.cardName);
	if (!cardName) error(400, 'Card name is required');

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

	const nameMatch = getByName(cardName);
	const printingMatch =
		setCode && collectorNumber ? getBySetColl(setCode, collectorNumber) : nameMatch;
	if (printingMatch && printingMatch.name.toLocaleLowerCase() !== cardName.toLocaleLowerCase()) {
		error(400, 'That set and collector number belong to a different card');
	}
	const now = Date.now();
	const [created] = await db
		.insert(proxyInventory)
		.values({
			cardName: nameMatch?.name ?? cardName,
			oracleId: printingMatch?.oracle_id ?? nameMatch?.oracle_id ?? null,
			scryfallId: printingMatch?.id ?? null,
			setCode,
			collectorNumber,
			location,
			printState,
			notes: optionalText(body.notes),
			createdAt: now,
			updatedAt: now
		})
		.returning();

	return json(created, { status: 201 });
};
