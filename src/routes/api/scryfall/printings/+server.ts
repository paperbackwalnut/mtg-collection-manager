import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { getPrintings } from '$lib/server/db/scryfall-sqlite';

export const GET: RequestHandler = async ({ url }) => {
	const name = url.searchParams.get('name')?.trim() ?? '';
	if (!name) error(400, 'name required');
	return json(getPrintings(name));
};
