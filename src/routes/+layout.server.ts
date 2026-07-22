import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db/index';
import { collection } from '$lib/server/db/schema';
import { sql } from 'drizzle-orm';
import { getStats as scryfallStats } from '$lib/server/db/scryfall-sqlite';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const load: LayoutServerLoad = async () => {
	// Cards that need enrichment = scryfallId IS NULL (never matched to Scryfall).
	const [{ cnt }] = await db
		.select({ cnt: sql<number>`count(*)` })
		.from(collection)
		.where(sql`${collection.scryfallId} IS NULL`);

	// Scryfall freshness comes from local SQLite (synchronous, instant).
	const { total: scryfallTotal, lastUpdated: maxUpdated } = scryfallStats();
	const scryfallStale = !maxUpdated || Date.now() - maxUpdated > THIRTY_DAYS_MS;

	return {
		unenrichedCount: cnt ?? 0,
		scryfallStale,
		scryfallLastUpdated: maxUpdated ?? null,
		scryfallTotal
	};
};
