import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { collectionSqlite } from '$lib/server/db/index';

export const GET: RequestHandler = () => {
	collectionSqlite.prepare('SELECT 1').get();
	return json({ status: 'ok' });
};
