import { isNotNull } from 'drizzle-orm';
import { db } from './db';
import { collection } from './db/schema';

export type CollectionSearchCandidate = {
	scryfallId: string;
	oracleId: string | null;
};

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedCandidates: CollectionSearchCandidate[] | null = null;
let cachedAt = 0;
let pendingLoad: Promise<CollectionSearchCandidate[]> | null = null;

async function loadCandidates(): Promise<CollectionSearchCandidate[]> {
	const rows = await db
		.selectDistinct({
			scryfallId: collection.scryfallId,
			oracleId: collection.oracleId
		})
		.from(collection)
		.where(isNotNull(collection.scryfallId));

	return rows.map((row) => ({
		scryfallId: row.scryfallId as string,
		oracleId: row.oracleId
	}));
}

export async function getCollectionSearchCandidates(): Promise<CollectionSearchCandidate[]> {
	const now = Date.now();
	if (cachedCandidates && now - cachedAt < CACHE_TTL_MS) return cachedCandidates;
	if (pendingLoad) return pendingLoad;

	pendingLoad = loadCandidates()
		.then((rows) => {
			cachedCandidates = rows;
			cachedAt = Date.now();
			return rows;
		})
		.finally(() => {
			pendingLoad = null;
		});

	return pendingLoad;
}

export function invalidateCollectionSearchCandidates(): void {
	cachedCandidates = null;
	cachedAt = 0;
}
