import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchOracleTagLabels } from '$lib/server/oracle-tag-directory';

export const GET: RequestHandler = async ({ url }) => {
	const query = url.searchParams.get('q') ?? '';
	const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '8', 10);
	const limit = Number.isFinite(requestedLimit) ? requestedLimit : 8;
	return json(searchOracleTagLabels(query, limit));
};
