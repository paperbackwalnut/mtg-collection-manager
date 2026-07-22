import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/index';
import { collection } from '$lib/server/db/schema';
import { enrichByIdentifiers } from '$lib/server/scryfall';
import { getOracleIdsByScryfallId } from '$lib/server/collection-oracle-id';
import { eq, sql } from 'drizzle-orm';
import { invalidateCollectionSearchCandidates } from '$lib/server/collection-search-candidates';

export const POST: RequestHandler = async () => {
	// Find all collection entries with no Scryfall match yet
	const unenriched = await db
		.select({
			id: collection.id,
			setCode: collection.setCode,
			collectorNumber: collection.collectorNumber
		})
		.from(collection)
		.where(sql`${collection.scryfallId} IS NULL`);

	if (unenriched.length === 0) {
		return json({ enriched: 0, notFound: 0 });
	}

	const identifiers = unenriched
		.filter((r) => r.setCode && r.collectorNumber)
		.map((r) => ({ setCode: r.setCode!, collectorNumber: r.collectorNumber! }));

	if (identifiers.length === 0) {
		return json({ enriched: 0, notFound: unenriched.length });
	}

	let scryfallMap: Map<string, string>;
	try {
		scryfallMap = await enrichByIdentifiers(identifiers);
	} catch (e) {
		return json(
			{ error: `Scryfall enrichment failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 }
		);
	}

	let enriched = 0;
	const oracleIds = getOracleIdsByScryfallId(scryfallMap.values());
	for (const row of unenriched) {
		if (!row.setCode || !row.collectorNumber) continue;
		const key = `${row.setCode}:${row.collectorNumber}`;
		const scryfallId = scryfallMap.get(key);
		if (scryfallId) {
			await db
				.update(collection)
				.set({ scryfallId, oracleId: oracleIds.get(scryfallId) ?? null })
				.where(eq(collection.id, row.id));
			enriched++;
		}
	}

	const notFound = identifiers.length - scryfallMap.size;
	if (enriched > 0) invalidateCollectionSearchCandidates();
	return json({ enriched, notFound });
};
