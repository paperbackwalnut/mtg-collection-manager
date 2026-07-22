import fs from 'node:fs';
import { dbFilePath, openDb } from './db/scryfall-sqlite';
import type { OracleTagFilter, SearchAST, SharedOracleTagIndex } from './scryfall-search';

export interface OracleTagCandidate {
	scryfallId: string;
	oracleId: string | null;
}

export interface OracleTagMembership {
	label: string;
	oracleId: string;
}

export function withoutOracleTagFilters(ast: SearchAST): SearchAST {
	return {
		...ast,
		filters: ast.filters.filter((filter) => filter.kind !== 'oracleTag')
	};
}

export function applySharedOracleTagFilters(
	candidates: OracleTagCandidate[],
	filters: OracleTagFilter[],
	memberships: OracleTagMembership[]
): string[] {
	if (filters.length === 0) return candidates.map((candidate) => candidate.scryfallId);

	const oracleIdsByLabel = new Map<string, Set<string>>();
	for (const membership of memberships) {
		const key = membership.label.toLowerCase();
		const ids = oracleIdsByLabel.get(key) ?? new Set<string>();
		ids.add(membership.oracleId);
		oracleIdsByLabel.set(key, ids);
	}

	return candidates
		.filter((candidate) => {
			if (!candidate.oracleId) return false;
			const oracleId = candidate.oracleId;
			return filters.every((filter) => {
				const matches = oracleIdsByLabel.get(filter.value.toLowerCase())?.has(oracleId) ?? false;
				return filter.negate ? !matches : matches;
			});
		})
		.map((candidate) => candidate.scryfallId);
}

function loadLocalMemberships(labels: string[]): OracleTagMembership[] {
	if (labels.length === 0 || !fs.existsSync(dbFilePath())) return [];
	const d = openDb();
	try {
		const placeholders = labels.map(() => '?').join(', ');
		return d
			.prepare(
				`SELECT lower(t.label) AS label, tc.oracle_id AS oracleId
			 FROM scryfall_oracle_tag_cards tc
			 JOIN scryfall_oracle_tags t ON t.id = tc.tag_id
			 WHERE lower(t.label) IN (${placeholders})`
			)
			.all(...labels) as OracleTagMembership[];
	} catch {
		return [];
	}
}

export async function executeSharedOracleTagFilters(
	ast: SearchAST,
	candidates: OracleTagCandidate[]
): Promise<{ ast: SearchAST; candidateIds: string[]; hadTagFilters: boolean }> {
	const filters = ast.filters.filter(
		(filter): filter is OracleTagFilter => filter.kind === 'oracleTag'
	);
	if (filters.length === 0) {
		return {
			ast,
			candidateIds: candidates.map((candidate) => candidate.scryfallId),
			hadTagFilters: false
		};
	}

	const labels = [...new Set(filters.map((filter) => filter.value.toLowerCase()))];
	const rows = loadLocalMemberships(labels);

	return {
		ast: withoutOracleTagFilters(ast),
		candidateIds: applySharedOracleTagFilters(candidates, filters, rows),
		hadTagFilters: true
	};
}

export async function resolveSharedOracleTagIndex(
	ast: SearchAST
): Promise<SharedOracleTagIndex | undefined> {
	const filters = ast.filters.filter(
		(filter): filter is OracleTagFilter => filter.kind === 'oracleTag'
	);
	if (filters.length === 0) return undefined;

	const labels = [...new Set(filters.map((filter) => filter.value.toLowerCase()))];
	const rows = loadLocalMemberships(labels);

	const index: SharedOracleTagIndex = new Map();
	for (const row of rows) {
		const ids = index.get(row.label) ?? new Set<string>();
		ids.add(row.oracleId);
		index.set(row.label, ids);
	}
	for (const label of labels) {
		if (!index.has(label)) index.set(label, new Set());
	}
	return index;
}
