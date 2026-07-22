import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { searchNames } from '$lib/server/db/scryfall-sqlite';

export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (q.length < 2) return json([]);
	return json(searchNames(q, 12));
};
