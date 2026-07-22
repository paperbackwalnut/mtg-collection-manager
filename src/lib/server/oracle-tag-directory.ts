import * as fs from 'node:fs';
import { dbFilePath, openDb } from './db/scryfall-sqlite';

const SQLITE_CHUNK_SIZE = 900;

export type OracleTagDirectoryState = 'ready' | 'missing_db' | 'tags_missing';

export interface OracleTagDirectoryEntry {
	label: string;
	description: string | null;
	collectionCount: number;
}

export interface OracleTagDirectoryResult {
	state: OracleTagDirectoryState;
	entries: OracleTagDirectoryEntry[];
	total: number;
	page: number;
	pageSize: number;
}

export interface OracleTagDirectoryOptions {
	query?: string;
	inCollectionOnly?: boolean;
	page?: number;
	pageSize?: number;
	collectionScryfallIds?: string[];
	dbPath?: string;
}

export interface OracleTagLabelSearchResult {
	state: OracleTagDirectoryState;
	labels: string[];
}

function readDirectoryState(
	d: ReturnType<typeof openDb>
): Exclude<OracleTagDirectoryState, 'missing_db'> {
	const hasTagTable = d
		.prepare(
			`SELECT 1 FROM sqlite_master
		 WHERE type = 'table' AND name = 'scryfall_oracle_tags'`
		)
		.get();
	if (!hasTagTable) return 'tags_missing';
	return d.prepare('SELECT 1 FROM scryfall_oracle_tags LIMIT 1').get() ? 'ready' : 'tags_missing';
}

export function getOracleTagDirectoryState(dbPath?: string): OracleTagDirectoryState {
	const resolvedPath = dbPath ?? dbFilePath();
	if (!fs.existsSync(resolvedPath)) return 'missing_db';
	const d = openDb(dbPath);
	try {
		return readDirectoryState(d);
	} finally {
		if (dbPath) d.close();
	}
}

export function searchOracleTagLabels(
	query: string,
	limit = 10,
	dbPath?: string
): OracleTagLabelSearchResult {
	const state = getOracleTagDirectoryState(dbPath);
	if (state !== 'ready') return { state, labels: [] };

	const d = openDb(dbPath);
	try {
		const pattern = `%${query.trim().replace(/[%_\\]/g, '\\$&')}%`;
		const rows = d
			.prepare(
				`SELECT MIN(label) AS label
			 FROM scryfall_oracle_tags
			 WHERE label LIKE ? ESCAPE '\\' COLLATE NOCASE
			 GROUP BY lower(label)
			 ORDER BY
				CASE WHEN lower(MIN(label)) LIKE lower(?) THEN 0 ELSE 1 END,
				MIN(label) COLLATE NOCASE
			 LIMIT ?`
			)
			.all(
				pattern,
				`${query.trim().replace(/[%_\\]/g, '\\$&')}%`,
				Math.max(1, Math.min(25, limit))
			) as Array<{ label: string }>;
		return { state: 'ready', labels: rows.map((row) => row.label) };
	} finally {
		if (dbPath) d.close();
	}
}

/**
 * List locally cached Oracle tags and annotate them with collection matches.
 * All work is synchronous/local SQLite; the caller supplies collection printing IDs.
 */
export function getOracleTagDirectory(
	options: OracleTagDirectoryOptions = {}
): OracleTagDirectoryResult {
	const resolvedPath = options.dbPath ?? dbFilePath();
	const pageSize = Math.max(1, Math.min(200, options.pageSize ?? 100));
	const requestedPage = Math.max(1, options.page ?? 1);
	const empty = (state: OracleTagDirectoryState): OracleTagDirectoryResult => ({
		state,
		entries: [],
		total: 0,
		page: 1,
		pageSize
	});

	if (!fs.existsSync(resolvedPath)) return empty('missing_db');

	const d = openDb(options.dbPath);
	try {
		const state = readDirectoryState(d);
		if (state !== 'ready') return empty(state);

		d.exec(`
			CREATE TEMP TABLE IF NOT EXISTS current_collection_oracle_ids (
				oracle_id TEXT PRIMARY KEY
			) WITHOUT ROWID;
			DELETE FROM current_collection_oracle_ids;
		`);

		const printingIds = [...new Set(options.collectionScryfallIds ?? [])];
		const insertOracleId = d.prepare(
			'INSERT OR IGNORE INTO current_collection_oracle_ids (oracle_id) VALUES (?)'
		);
		d.transaction(() => {
			for (let i = 0; i < printingIds.length; i += SQLITE_CHUNK_SIZE) {
				const chunk = printingIds.slice(i, i + SQLITE_CHUNK_SIZE);
				if (chunk.length === 0) continue;
				const placeholders = chunk.map(() => '?').join(', ');
				const rows = d
					.prepare(
						`SELECT DISTINCT oracle_id
					 FROM scryfall_cache
					 WHERE id IN (${placeholders}) AND oracle_id IS NOT NULL`
					)
					.all(...chunk) as Array<{ oracle_id: string }>;
				for (const row of rows) insertOracleId.run(row.oracle_id);
			}
		})();

		const query = options.query?.trim() ?? '';
		const pattern = `%${query.replace(/[%_\\]/g, '\\$&')}%`;
		const tags = d
			.prepare(
				`SELECT
				MIN(label) AS label,
				MAX(description) AS description
			 FROM scryfall_oracle_tags
			 WHERE label LIKE ? ESCAPE '\\' COLLATE NOCASE
			 GROUP BY lower(label)
			 ORDER BY label COLLATE NOCASE`
			)
			.all(pattern) as Array<{ label: string; description: string | null }>;

		const ownedRows = d
			.prepare(
				`SELECT lower(t.label) AS label_key, COUNT(DISTINCT owned.oracle_id) AS collection_count
			 FROM current_collection_oracle_ids owned
			 JOIN scryfall_oracle_tag_cards tc ON tc.oracle_id = owned.oracle_id
			 JOIN scryfall_oracle_tags t ON t.id = tc.tag_id
			 GROUP BY lower(t.label)`
			)
			.all() as Array<{ label_key: string; collection_count: number }>;
		const ownedCounts = new Map(
			ownedRows.map((row) => [row.label_key, Number(row.collection_count)])
		);

		let entries = tags.map((tag) => ({
			label: tag.label,
			description: tag.description,
			collectionCount: ownedCounts.get(tag.label.toLowerCase()) ?? 0
		}));
		if (options.inCollectionOnly) {
			entries = entries.filter((tag) => tag.collectionCount > 0);
		}

		const total = entries.length;
		const maxPage = Math.max(1, Math.ceil(total / pageSize));
		const page = Math.min(requestedPage, maxPage);
		const start = (page - 1) * pageSize;

		return {
			state: 'ready',
			entries: entries.slice(start, start + pageSize),
			total,
			page,
			pageSize
		};
	} finally {
		try {
			d.exec('DROP TABLE IF EXISTS current_collection_oracle_ids');
		} finally {
			if (options.dbPath) d.close();
		}
	}
}
