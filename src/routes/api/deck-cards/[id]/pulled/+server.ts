import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db/index';
import { deckCards, cardAssignments } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';

/**
 * PATCH /api/deck-cards/[id]/pulled  { count: number }
 *
 * Sets exactly `count` assignments for this deck card to pulled=true
 * (used for basic lands tracked by hand count — no collection link needed).
 * Remaining assignments get pulled=false.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const dcId = parseInt(params.id);
	if (isNaN(dcId)) error(400, 'Invalid id');

	let body: { count: number };
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON');
	}

	const count = Math.max(0, Math.floor(body.count ?? 0));

	const [dc] = await db
		.select({ id: deckCards.id, quantity: deckCards.quantity })
		.from(deckCards)
		.where(eq(deckCards.id, dcId))
		.limit(1);
	if (!dc) error(404, 'Deck card not found');

	const assignments = await db
		.select({ id: cardAssignments.id })
		.from(cardAssignments)
		.where(eq(cardAssignments.deckCardId, dcId))
		.orderBy(cardAssignments.id);

	const pulledIds = assignments.slice(0, count).map((a) => a.id);
	const neededIds = assignments.slice(count).map((a) => a.id);

	if (pulledIds.length > 0) {
		await db
			.update(cardAssignments)
			.set({ pulled: true })
			.where(inArray(cardAssignments.id, pulledIds));
	}
	if (neededIds.length > 0) {
		await db
			.update(cardAssignments)
			.set({ pulled: false })
			.where(inArray(cardAssignments.id, neededIds));
	}

	return json({ ok: true, pulled: pulledIds.length, notPulled: neededIds.length });
};
