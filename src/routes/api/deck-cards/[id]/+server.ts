import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db/index';
import { deckCards } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = parseInt(params.id);
	if (isNaN(id)) error(400, 'Invalid id');

	let body: { notes?: unknown };
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON');
	}

	if (body.notes === undefined || (body.notes !== null && typeof body.notes !== 'string')) {
		return json({ error: 'Only a string or null notes value is supported.' }, { status: 400 });
	}
	const [existing] = await db
		.select({ id: deckCards.id })
		.from(deckCards)
		.where(eq(deckCards.id, id))
		.limit(1);
	if (!existing) error(404, 'Deck card not found');
	const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null;
	await db.update(deckCards).set({ notes }).where(eq(deckCards.id, id));
	return json({ ok: true });
};
