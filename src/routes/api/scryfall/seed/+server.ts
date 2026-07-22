import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Readable } from 'node:stream';
import { seedScryfallCache } from '$lib/server/scryfall';

/**
 * POST /api/scryfall/seed
 *
 * Accepts the Scryfall default_cards bulk JSON as the raw request body
 * (Content-Type: application/octet-stream or application/json).
 *
 * The body is streamed directly — not buffered — so a 500 MB file is fine.
 * Client usage:
 *   fetch('/api/scryfall/seed', { method: 'POST', body: file })
 */
export const POST: RequestHandler = async ({ request }) => {
	console.log('[Scryfall seed] Upload request received');

	if (!request.body) {
		console.warn('[Scryfall seed] No request body — returning 400');
		return json({ error: 'No body provided' }, { status: 400 });
	}

	const contentLength = request.headers.get('content-length');
	if (contentLength) {
		const mb = Math.round(parseInt(contentLength) / 1024 / 1024);
		console.log(`[Scryfall seed] Content-Length: ${mb} MB`);
	}

	try {
		// NOTE: In the Vite dev server, the body has already been fully buffered into
		// memory before this handler runs. For a 500 MB file that means 500 MB of heap.
		// Prefer the "Seed from local file" form action on the /collection/scryfall page
		// which reads from disk and never buffers.
		const stream = Readable.fromWeb(request.body as import('stream/web').ReadableStream);
		const { inserted, total } = await seedScryfallCache(stream);
		return json({ inserted, total });
	} catch (e) {
		console.error('[Scryfall seed] Error:', e);
		return json({ error: String(e) }, { status: 500 });
	}
};
