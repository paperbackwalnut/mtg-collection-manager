import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { syncOneDeck } from '$lib/server/sync-deck';

/**
 * POST /api/sync-deck
 * Body: { deckId: number }
 *
 * Called by the client-side bulk-sync loop on the /decks page.
 * Always returns JSON — never redirects. Errors are returned as
 * { error: string } with an appropriate HTTP status so the caller
 * can continue syncing the remaining decks.
 */
export const POST: RequestHandler = async ({ request }) => {
	let deckId: unknown;
	try {
		({ deckId } = await request.json());
	} catch {
		return json({ error: 'Invalid request body' }, { status: 400 });
	}

	if (typeof deckId !== 'number' || !Number.isInteger(deckId) || deckId <= 0) {
		return json({ error: 'deckId must be a positive integer' }, { status: 400 });
	}

	try {
		const result = await syncOneDeck(deckId);
		return json({ deckId, result });
	} catch (e) {
		return json({ deckId, error: String(e) }, { status: 500 });
	}
};
