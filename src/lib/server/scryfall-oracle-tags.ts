/**
 * src/lib/server/scryfall-oracle-tags.ts
 *
 * Oracle-tag importer for the local Scryfall cache.
 *
 * Fetches from Scryfall's undocumented oracle-tags endpoint and stores the
 * results in scryfall.db alongside scryfall_cache.  All undocumented API
 * contract assumptions are isolated here so the rest of the app never depends
 * on this endpoint.
 *
 * Normal startup and search paths NEVER import this module.  It is invoked only
 * by scripts/fetch-scryfall-oracle-tags.ts or an admin route.
 *
 * Tables managed here (created on first use):
 *   scryfall_oracle_tags       — one row per tag; label has COLLATE NOCASE (not UNIQUE)
 *   scryfall_oracle_tag_cards  — (tag_id, oracle_id) many-to-many
 *   scryfall_tag_metadata      — refresh timestamps, etag, counts
 *   scryfall_refresh_lock      — cross-process advisory mutex
 */

import Database from 'better-sqlite3';
import { dbFilePath } from './db/scryfall-sqlite';

// ── Undocumented endpoint — all contract assumptions isolated here ─────────────
export const TAGS_ENDPOINT = 'https://api.scryfall.com/private/tags/oracle';

export const DEFAULT_HEADERS = {
	'User-Agent': 'MTGCollectionManager/1.0 (local application; oracle-tag import)',
	Accept: 'application/json'
};

// ── DDL constants ─────────────────────────────────────────────────────────────

/**
 * Only creates metadata + lock tables. Never touches scryfall_oracle_tags or
 * scryfall_oracle_tag_cards. Safe to call at any time, even on a legacy DB.
 * Used by both refreshOracleTags and getTagMetadata.
 */
const META_LOCK_DDL = `
  CREATE TABLE IF NOT EXISTS scryfall_tag_metadata (
    kind           TEXT    PRIMARY KEY,
    fetched_at     INTEGER NOT NULL,
    etag           TEXT,
    tag_count      INTEGER NOT NULL DEFAULT 0,
    relation_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS scryfall_refresh_lock (
    kind      TEXT    PRIMARY KEY,
    locked_at INTEGER NOT NULL,
    pid       INTEGER NOT NULL
  );
`;

/**
 * Creates tag tables with IF NOT EXISTS — for fresh DBs only (non-legacy path).
 * Must NOT be called when legacy tables exist (those are rebuilt inside the
 * replacement transaction).
 */
const NEW_TAG_DDL = `
  CREATE TABLE IF NOT EXISTS scryfall_oracle_tags (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL COLLATE NOCASE,
    description TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sot_label ON scryfall_oracle_tags(label COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS scryfall_oracle_tag_cards (
    tag_id    TEXT NOT NULL,
    oracle_id TEXT NOT NULL,
    PRIMARY KEY (tag_id, oracle_id),
    FOREIGN KEY (tag_id) REFERENCES scryfall_oracle_tags(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sotc_tag    ON scryfall_oracle_tag_cards(tag_id);
  CREATE INDEX IF NOT EXISTS idx_sotc_oracle ON scryfall_oracle_tag_cards(oracle_id);
`;

// ── Legacy schema detection ───────────────────────────────────────────────────

/**
 * Returns true if scryfall_oracle_tags exists with the old UNIQUE-on-label
 * schema.  Detection only — never modifies the database.
 */
function hasLegacyTagSchema(d: Database.Database): boolean {
	const row = d
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='scryfall_oracle_tags'`)
		.get() as { sql: string } | undefined;
	return !!(row && /\bUNIQUE\b/.test(row.sql));
}

// ── Response shape (undocumented — validate before trusting) ──────────────────

export interface RawOracleTag {
	id: string;
	label: string;
	description?: string;
	oracle_ids: string[];
}

export interface RawTagsResponse {
	object: string;
	data: RawOracleTag[];
}

export function validateResponse(raw: unknown): RawTagsResponse {
	if (typeof raw !== 'object' || raw === null) {
		throw new Error('Tags response is not an object');
	}
	const obj = raw as Record<string, unknown>;
	if (obj.object !== 'list') {
		throw new Error(`Unexpected response object type: ${String(obj.object)}`);
	}
	if (!Array.isArray(obj.data)) {
		throw new Error('Tags response data is not an array');
	}
	if (obj.data.length === 0) {
		throw new Error('Tags response data is empty — refusing to replace existing data with nothing');
	}
	for (let i = 0; i < obj.data.length; i++) {
		const tag = obj.data[i];
		if (typeof tag !== 'object' || tag === null) {
			throw new Error(`Tag[${i}] is not an object`);
		}
		const t = tag as Record<string, unknown>;
		if (typeof t.id !== 'string' || !t.id) throw new Error(`Tag[${i}] missing id`);
		if (typeof t.label !== 'string' || !t.label) throw new Error(`Tag[${i}] missing label`);
		if (!Array.isArray(t.oracle_ids)) throw new Error(`Tag[${i}] oracle_ids is not an array`);
		for (let j = 0; j < t.oracle_ids.length; j++) {
			if (typeof (t.oracle_ids as unknown[])[j] !== 'string') {
				throw new Error(`Tag[${i}].oracle_ids[${j}] is not a string`);
			}
		}
	}
	return raw as RawTagsResponse;
}

// ── Cross-process advisory lock ───────────────────────────────────────────────
// SQLite's transaction atomicity ensures only one process acquires the lock.
// Stale locks (> 10 min) are cleared automatically so a crashed process cannot
// block future runs.

export const LOCK_STALE_MS = 10 * 60 * 1000;

function acquireLock(d: Database.Database): boolean {
	const now = Date.now();
	try {
		d.transaction(() => {
			d.prepare(`DELETE FROM scryfall_refresh_lock WHERE kind = 'oracle' AND locked_at < ?`).run(
				now - LOCK_STALE_MS
			);
			d.prepare(
				`INSERT INTO scryfall_refresh_lock (kind, locked_at, pid) VALUES ('oracle', ?, ?)`
			).run(now, process.pid);
		})();
		return true;
	} catch {
		return false;
	}
}

function releaseLock(d: Database.Database): void {
	try {
		d.prepare(`DELETE FROM scryfall_refresh_lock WHERE kind = 'oracle' AND pid = ?`).run(
			process.pid
		);
	} catch {
		// best-effort; db may already be closing
	}
}

// ── In-process guard (fast path — no DB needed) ───────────────────────────────
let _refreshing = false;

// ── Public types ──────────────────────────────────────────────────────────────

export interface TagRefreshResult {
	status: 'ok' | 'not_modified' | 'already_running' | 'error';
	tagCount?: number;
	relationCount?: number;
	etag?: string | null;
	error?: string;
}

export interface TagMetadata {
	fetched_at: number;
	etag: string | null;
	tag_count: number;
	relation_count: number;
}

export interface RefreshOptions {
	/** Override the DB file path (used by tests to inject a temp DB). */
	dbPath?: string;
	/** Override the fetch implementation (used by tests to avoid network calls). */
	fetchImpl?: typeof globalThis.fetch;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch oracle tags from Scryfall and replace the local cache atomically.
 *
 * Normal (non-legacy) path:
 * - Sends If-None-Match when an ETag is stored; accepts 304 as "no change".
 * - Replaces rows in one transaction; existing data survives on any error.
 *
 * Legacy schema path (scryfall_oracle_tags has old UNIQUE-on-label):
 * - Always sends an unconditional request (no If-None-Match) to guarantee a
 *   200 response and a full validated dataset before touching the DB.
 * - 304 is treated as an error — it must not be accepted as success.
 * - The DROP + CREATE + INSERT all happen inside a single transaction so the
 *   legacy tables are restored by rollback if anything goes wrong.
 *
 * Protected by both an in-process flag and a cross-process SQLite lock.
 */
export async function refreshOracleTags(options: RefreshOptions = {}): Promise<TagRefreshResult> {
	const resolvedDbPath = options.dbPath ?? dbFilePath();
	const fetchFn = options.fetchImpl ?? globalThis.fetch;

	// Fast path: in-process guard
	if (_refreshing) return { status: 'already_running' };
	_refreshing = true;

	const d = new Database(resolvedDbPath);
	d.pragma('foreign_keys = ON');

	// Step 1: ensure metadata + lock tables exist — never touches tag tables
	d.exec(META_LOCK_DDL);

	// Step 2: detect legacy schema (read-only, no modifications)
	const isLegacy = hasLegacyTagSchema(d);

	// Step 3: for non-legacy path, ensure tag tables exist
	if (!isLegacy) {
		d.exec(NEW_TAG_DDL);
	}

	// Step 4: cross-process lock
	if (!acquireLock(d)) {
		_refreshing = false;
		d.close();
		return { status: 'already_running' };
	}

	try {
		// Step 5: build request headers
		// On legacy schema: omit If-None-Match to force an unconditional 200 fetch
		const headers: Record<string, string> = { ...DEFAULT_HEADERS };
		if (!isLegacy) {
			const storedMeta = d
				.prepare(`SELECT etag FROM scryfall_tag_metadata WHERE kind = 'oracle'`)
				.get() as { etag: string | null } | undefined;
			if (storedMeta?.etag) headers['If-None-Match'] = storedMeta.etag;
		}

		const res = await fetchFn(TAGS_ENDPOINT, { headers });

		if (res.status === 304) {
			if (isLegacy) {
				// We never sent If-None-Match, so 304 is unexpected. Treat as error —
				// the legacy data is still intact (we haven't touched it).
				throw new Error(
					'Unexpected 304 during legacy schema migration — no If-None-Match was sent'
				);
			}
			const storedEtag =
				(
					d.prepare(`SELECT etag FROM scryfall_tag_metadata WHERE kind = 'oracle'`).get() as
						| { etag: string | null }
						| undefined
				)?.etag ?? null;
			return { status: 'not_modified', etag: storedEtag };
		}

		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
		}

		const newEtag = res.headers.get('etag');
		const raw: unknown = await res.json();

		// Step 6: validate the full response before touching the database
		const validated = validateResponse(raw);

		let tagCount = 0;
		let relationCount = 0;

		// Step 7: atomic replacement
		// For legacy path, DROP + CREATE happen inside this same transaction so
		// SQLite's transactional DDL rolls them back if INSERT fails.
		// Note: d.exec() throws inside a transaction; use prepare().run() for DDL.
		d.transaction(() => {
			if (isLegacy) {
				// Drop child table first (FK constraint on tag_id), then parent
				d.prepare('DROP TABLE IF EXISTS scryfall_oracle_tag_cards').run();
				d.prepare('DROP TABLE IF EXISTS scryfall_oracle_tags').run();
				// Recreate with corrected schema (no UNIQUE on label)
				d.prepare(
					`
					CREATE TABLE scryfall_oracle_tags (
						id          TEXT PRIMARY KEY,
						label       TEXT NOT NULL COLLATE NOCASE,
						description TEXT
					)
				`
				).run();
				d.prepare(`CREATE INDEX idx_sot_label ON scryfall_oracle_tags(label COLLATE NOCASE)`).run();
				d.prepare(
					`
					CREATE TABLE scryfall_oracle_tag_cards (
						tag_id    TEXT NOT NULL,
						oracle_id TEXT NOT NULL,
						PRIMARY KEY (tag_id, oracle_id),
						FOREIGN KEY (tag_id) REFERENCES scryfall_oracle_tags(id) ON DELETE CASCADE
					)
				`
				).run();
				d.prepare(`CREATE INDEX idx_sotc_tag ON scryfall_oracle_tag_cards(tag_id)`).run();
				d.prepare(`CREATE INDEX idx_sotc_oracle ON scryfall_oracle_tag_cards(oracle_id)`).run();
			} else {
				// Normal path: clear existing rows
				d.prepare('DELETE FROM scryfall_oracle_tag_cards').run();
				d.prepare('DELETE FROM scryfall_oracle_tags').run();
			}

			const insertTag = d.prepare(
				`INSERT INTO scryfall_oracle_tags (id, label, description) VALUES (?, ?, ?)`
			);
			const insertRel = d.prepare(
				`INSERT INTO scryfall_oracle_tag_cards (tag_id, oracle_id) VALUES (?, ?)`
			);

			for (const tag of validated.data) {
				insertTag.run(tag.id, tag.label, tag.description ?? null);
				tagCount++;
				for (const oracleId of tag.oracle_ids) {
					insertRel.run(tag.id, oracleId);
					relationCount++;
				}
			}

			d.prepare(
				`
				INSERT INTO scryfall_tag_metadata (kind, fetched_at, etag, tag_count, relation_count)
				VALUES ('oracle', ?, ?, ?, ?)
				ON CONFLICT(kind) DO UPDATE SET
					fetched_at     = excluded.fetched_at,
					etag           = excluded.etag,
					tag_count      = excluded.tag_count,
					relation_count = excluded.relation_count
			`
			).run(Date.now(), newEtag, tagCount, relationCount);
		})();

		return { status: 'ok', tagCount, relationCount, etag: newEtag };
	} catch (err) {
		return { status: 'error', error: err instanceof Error ? err.message : String(err) };
	} finally {
		releaseLock(d);
		_refreshing = false;
		d.close();
	}
}

/**
 * Read stored tag metadata without hitting the network.
 * Only creates scryfall_tag_metadata if it doesn't exist — never touches or
 * migrates the tag tables.
 */
export function getTagMetadata(dbPath?: string): TagMetadata | null {
	const resolvedPath = dbPath ?? dbFilePath();
	const d = new Database(resolvedPath);
	d.exec(META_LOCK_DDL);
	try {
		return (
			(d
				.prepare(
					`SELECT fetched_at, etag, tag_count, relation_count
					 FROM scryfall_tag_metadata WHERE kind = 'oracle'`
				)
				.get() as TagMetadata | undefined) ?? null
		);
	} finally {
		d.close();
	}
}
