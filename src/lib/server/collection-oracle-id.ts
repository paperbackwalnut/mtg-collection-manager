import { getByIds } from './db/scryfall-sqlite';

export type CollectionIdentityRow = {
	id: number;
	scryfallId: string | null;
	oracleId: string | null;
};

export type OracleIdUpdate = {
	id: number;
	oracleId: string;
};

export function getOracleIdsByScryfallId(
	scryfallIds: Iterable<string | null | undefined>
): Map<string, string> {
	const cards = getByIds(scryfallIds);
	const oracleIds = new Map<string, string>();

	for (const [scryfallId, card] of cards) {
		if (card.oracle_id) oracleIds.set(scryfallId, card.oracle_id);
	}

	return oracleIds;
}

export function resolveMissingOracleIds(
	rows: CollectionIdentityRow[],
	oracleIdsByScryfallId: ReadonlyMap<string, string>
): OracleIdUpdate[] {
	const updates: OracleIdUpdate[] = [];

	for (const row of rows) {
		if (row.oracleId || !row.scryfallId) continue;
		const oracleId = oracleIdsByScryfallId.get(row.scryfallId);
		if (oracleId) updates.push({ id: row.id, oracleId });
	}

	return updates;
}
