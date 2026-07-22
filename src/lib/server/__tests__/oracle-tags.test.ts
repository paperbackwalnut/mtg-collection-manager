/**
 * Focused tests for scryfall-oracle-tags.ts
 *
 * Uses injected dbPath + fetchImpl so tests never hit the network or
 * touch production scryfall.db.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
	refreshOracleTags,
	getTagMetadata,
	validateResponse,
	LOCK_STALE_MS
} from '../scryfall-oracle-tags';
import { openDb } from '../db/scryfall-sqlite';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tempDbPath(): string {
	return path.join(
		os.tmpdir(),
		`scryfall-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
	);
}

function removeTempDb(p: string) {
	try {
		fs.unlinkSync(p);
	} catch {
		/* ignore */
	}
	try {
		fs.unlinkSync(p + '-wal');
	} catch {
		/* ignore */
	}
	try {
		fs.unlinkSync(p + '-shm');
	} catch {
		/* ignore */
	}
}

/** Old schema: 13 original columns, no new columns, no idx_sc_oracle. */
function createOldSchemaDb(p: string): void {
	const db = new Database(p);
	db.exec(`
		CREATE TABLE scryfall_cache (
			id               TEXT    PRIMARY KEY,
			name             TEXT    NOT NULL,
			set_code         TEXT    NOT NULL,
			collector_number TEXT    NOT NULL,
			type_line        TEXT    NOT NULL DEFAULT '',
			mana_cost        TEXT    NOT NULL DEFAULT '',
			cmc              REAL    NOT NULL DEFAULT 0,
			oracle_text      TEXT,
			image_uri        TEXT,
			back_image_uri   TEXT,
			price_usd        REAL,
			price_usd_foil   REAL,
			last_updated     INTEGER NOT NULL
		);
		CREATE INDEX idx_sc_set_coll ON scryfall_cache(set_code, collector_number);
		CREATE INDEX idx_sc_name     ON scryfall_cache(name);
	`);
	db.prepare(
		`
		INSERT INTO scryfall_cache
			(id, name, set_code, collector_number, type_line, mana_cost, cmc, last_updated)
		VALUES ('abc123', 'Lightning Bolt', 'lea', '161', 'Instant', '{R}', 1, 1000)
	`
	).run();
	db.close();
}

/**
 * Creates a DB with the old UNIQUE-on-label tag schema (pre-correction).
 * Optionally pre-populates tag data and an ETag in metadata.
 */
function createLegacyTagDb(
	p: string,
	tags?: { id: string; label: string; oracle_ids: string[] }[],
	storedEtag?: string
): void {
	const db = new Database(p);
	db.exec(`
		CREATE TABLE scryfall_oracle_tags (
			id          TEXT PRIMARY KEY,
			label       TEXT NOT NULL COLLATE NOCASE UNIQUE,
			description TEXT
		);
		CREATE TABLE scryfall_oracle_tag_cards (
			tag_id    TEXT NOT NULL,
			oracle_id TEXT NOT NULL,
			PRIMARY KEY (tag_id, oracle_id),
			FOREIGN KEY (tag_id) REFERENCES scryfall_oracle_tags(id) ON DELETE CASCADE
		);
		CREATE TABLE scryfall_tag_metadata (
			kind           TEXT    PRIMARY KEY,
			fetched_at     INTEGER NOT NULL,
			etag           TEXT,
			tag_count      INTEGER NOT NULL DEFAULT 0,
			relation_count INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE scryfall_refresh_lock (
			kind      TEXT PRIMARY KEY,
			locked_at INTEGER NOT NULL,
			pid       INTEGER NOT NULL
		);
	`);
	if (tags && tags.length > 0) {
		const insertTag = db.prepare(`INSERT INTO scryfall_oracle_tags (id, label) VALUES (?, ?)`);
		const insertRel = db.prepare(
			`INSERT INTO scryfall_oracle_tag_cards (tag_id, oracle_id) VALUES (?, ?)`
		);
		for (const tag of tags) {
			insertTag.run(tag.id, tag.label);
			for (const oid of tag.oracle_ids) insertRel.run(tag.id, oid);
		}
		const relCount = tags.reduce((s, t) => s + t.oracle_ids.length, 0);
		db.prepare(
			`
			INSERT INTO scryfall_tag_metadata (kind, fetched_at, etag, tag_count, relation_count)
			VALUES ('oracle', ?, ?, ?, ?)
		`
		).run(Date.now(), storedEtag ?? null, tags.length, relCount);
	}
	db.close();
}

function makeOkFetch(body: unknown, etag?: string): typeof globalThis.fetch {
	return async (_url, _init) => {
		return {
			ok: true,
			status: 200,
			headers: new Headers(etag ? { etag } : {}),
			json: async () => body,
			text: async () => JSON.stringify(body)
		} as Response;
	};
}

function make304Fetch(etag: string): typeof globalThis.fetch {
	return async () =>
		({
			ok: false,
			status: 304,
			headers: new Headers({ etag }),
			json: async () => {
				throw new Error('no body on 304');
			},
			text: async () => ''
		}) as unknown as Response;
}

function makeErrorFetch(status: number, body = ''): typeof globalThis.fetch {
	return async () =>
		({
			ok: false,
			status,
			headers: new Headers(),
			json: async () => {
				throw new Error('no body');
			},
			text: async () => body
		}) as unknown as Response;
}

/**
 * Returns a fetch mock that captures the request headers from each call.
 * The captured array is populated in-place so the caller can inspect it after.
 */
function makeFetchCapturingHeaders(
	body: unknown,
	etag?: string
): { fetchImpl: typeof globalThis.fetch; captured: RequestInit[] } {
	const captured: RequestInit[] = [];
	const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
		captured.push(init ?? {});
		return {
			ok: true,
			status: 200,
			headers: new Headers(etag ? { etag } : {}),
			json: async () => body,
			text: async () => JSON.stringify(body)
		} as Response;
	};
	return { fetchImpl, captured };
}

const VALID_RESPONSE = {
	object: 'list',
	data: [
		{
			id: 'tag-1',
			label: 'Ramp',
			description: 'Mana acceleration',
			oracle_ids: ['oid-a', 'oid-b']
		},
		{ id: 'tag-2', label: 'Removal', oracle_ids: ['oid-c'] }
	]
};

// ── Migration tests ───────────────────────────────────────────────────────────

describe('scryfall_cache migration', () => {
	it('adds all search columns to an old-schema DB and creates idx_sc_oracle', () => {
		const p = tempDbPath();
		try {
			createOldSchemaDb(p);
			openDb(p).close();

			// Verify
			const verify = new Database(p);
			const cols = (
				verify.prepare('PRAGMA table_info(scryfall_cache)').all() as { name: string }[]
			).map((r) => r.name);
			expect(cols).toContain('oracle_id');
			expect(cols).toContain('colors');
			expect(cols).toContain('color_identity');
			expect(cols).toContain('rarity');
			expect(cols).toContain('edhrec_rank');
			expect(cols).toContain('legalities');
			expect(cols).toContain('power');
			expect(cols).toContain('toughness');
			expect(cols).toContain('loyalty');
			expect(cols).toContain('keywords');
			expect(cols).toContain('produced_mana');
			expect(cols).toContain('artist');
			expect(cols).toContain('flavor_text');
			expect(cols).toContain('watermark');
			expect(cols).toContain('released_at');
			expect(cols).toContain('printing_metadata');

			const indexes = (
				verify.prepare(`PRAGMA index_list(scryfall_cache)`).all() as { name: string }[]
			).map((r) => r.name);
			expect(indexes).toContain('idx_sc_oracle');

			// Existing row is preserved
			const row = verify.prepare(`SELECT name FROM scryfall_cache WHERE id = 'abc123'`).get() as {
				name: string;
			};
			expect(row.name).toBe('Lightning Bolt');
			verify.close();
		} finally {
			removeTempDb(p);
		}
	});

	it('migration is idempotent on a new-schema DB', () => {
		const p = tempDbPath();
		try {
			openDb(p).close();
			openDb(p).close();
		} finally {
			removeTempDb(p);
		}
	});
});

// ── validateResponse tests ────────────────────────────────────────────────────

describe('validateResponse', () => {
	it('accepts a valid response', () => {
		expect(() => validateResponse(VALID_RESPONSE)).not.toThrow();
		const result = validateResponse(VALID_RESPONSE);
		expect(result.data).toHaveLength(2);
	});

	it('rejects a non-object', () => {
		expect(() => validateResponse('not an object')).toThrow('not an object');
	});

	it('rejects wrong object type', () => {
		expect(() => validateResponse({ object: 'card', data: [] })).toThrow('object type');
	});

	it('rejects empty data array', () => {
		expect(() => validateResponse({ object: 'list', data: [] })).toThrow('empty');
	});

	it('rejects a tag missing id', () => {
		expect(() =>
			validateResponse({
				object: 'list',
				data: [{ label: 'Ramp', oracle_ids: [] }]
			})
		).toThrow('missing id');
	});

	it('rejects a tag missing label', () => {
		expect(() =>
			validateResponse({
				object: 'list',
				data: [{ id: 'x', oracle_ids: [] }]
			})
		).toThrow('missing label');
	});

	it('rejects oracle_ids that is not an array', () => {
		expect(() =>
			validateResponse({
				object: 'list',
				data: [{ id: 'x', label: 'Ramp', oracle_ids: 'not-an-array' }]
			})
		).toThrow('oracle_ids is not an array');
	});

	it('rejects non-string oracle_id entries', () => {
		expect(() =>
			validateResponse({
				object: 'list',
				data: [{ id: 'x', label: 'Ramp', oracle_ids: [42] }]
			})
		).toThrow('oracle_ids[0] is not a string');
	});
});

// ── refreshOracleTags — normal path ───────────────────────────────────────────

describe('refreshOracleTags', () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = tempDbPath();
	});

	// afterEach is intentionally omitted — temp files are cleaned up by the OS,
	// and leaving them lets you inspect failures manually. On CI tmpdir is cleared.

	it('inserts tags and relations on a successful fetch', async () => {
		const result = await refreshOracleTags({
			dbPath,
			fetchImpl: makeOkFetch(VALID_RESPONSE, '"etag-v1"')
		});

		expect(result.status).toBe('ok');
		expect(result.tagCount).toBe(2);
		expect(result.relationCount).toBe(3);
		expect(result.etag).toBe('"etag-v1"');

		const db = new Database(dbPath);
		const tags = db.prepare('SELECT * FROM scryfall_oracle_tags ORDER BY id').all() as {
			id: string;
			label: string;
		}[];
		expect(tags).toHaveLength(2);
		expect(tags[0].id).toBe('tag-1');
		expect(tags[1].label).toBe('Removal');

		const rels = db.prepare('SELECT * FROM scryfall_oracle_tag_cards').all();
		expect(rels).toHaveLength(3);

		const meta = getTagMetadata(dbPath);
		expect(meta).not.toBeNull();
		expect(meta!.tag_count).toBe(2);
		expect(meta!.etag).toBe('"etag-v1"');
		db.close();
	});

	it('returns not_modified on 304 (normal schema) and preserves existing data', async () => {
		// First: successful fetch
		await refreshOracleTags({ dbPath, fetchImpl: makeOkFetch(VALID_RESPONSE, '"etag-v1"') });

		// Second: 304
		const result = await refreshOracleTags({
			dbPath,
			fetchImpl: make304Fetch('"etag-v1"')
		});

		expect(result.status).toBe('not_modified');

		// Data from first fetch still present
		const db = new Database(dbPath);
		const count = (
			db.prepare('SELECT COUNT(*) AS n FROM scryfall_oracle_tags').get() as { n: number }
		).n;
		expect(count).toBe(2);
		db.close();
	});

	it('rolls back and preserves prior data when validation fails', async () => {
		// First: good data
		await refreshOracleTags({ dbPath, fetchImpl: makeOkFetch(VALID_RESPONSE) });

		// Second: bad response (empty data → validation throws)
		const bad = { object: 'list', data: [] };
		const result = await refreshOracleTags({ dbPath, fetchImpl: makeOkFetch(bad) });

		expect(result.status).toBe('error');
		expect(result.error).toMatch(/empty/i);

		// Original 2 tags still intact
		const db = new Database(dbPath);
		const count = (
			db.prepare('SELECT COUNT(*) AS n FROM scryfall_oracle_tags').get() as { n: number }
		).n;
		expect(count).toBe(2);
		db.close();
	});

	it('rolls back and preserves prior data when the transaction itself fails (duplicate tag id)', async () => {
		// First: good data
		await refreshOracleTags({ dbPath, fetchImpl: makeOkFetch(VALID_RESPONSE) });

		// Second: two entries share the same id — PK constraint fires inside the transaction
		const duplicate = {
			object: 'list',
			data: [
				{ id: 'tag-same', label: 'Ramp', oracle_ids: ['oid-1'] },
				{ id: 'tag-same', label: 'Counter', oracle_ids: ['oid-2'] } // duplicate PK
			]
		};
		const result = await refreshOracleTags({ dbPath, fetchImpl: makeOkFetch(duplicate) });

		expect(result.status).toBe('error');

		// Original 2 tags still intact
		const db = new Database(dbPath);
		const count = (
			db.prepare('SELECT COUNT(*) AS n FROM scryfall_oracle_tags').get() as { n: number }
		).n;
		expect(count).toBe(2);
		db.close();
	});

	it('accepts duplicate labels with different ids (COLLATE NOCASE does not imply UNIQUE)', async () => {
		// Scryfall's real data has labels that collide case-insensitively; that must not crash
		const withDupeLabels = {
			object: 'list',
			data: [
				{ id: 'tag-a', label: 'Ramp', oracle_ids: ['oid-1'] },
				{ id: 'tag-b', label: 'ramp', oracle_ids: ['oid-2'] }, // same label, different id — allowed
				{ id: 'tag-c', label: 'Counter', oracle_ids: ['oid-3'] }
			]
		};
		const result = await refreshOracleTags({ dbPath, fetchImpl: makeOkFetch(withDupeLabels) });
		expect(result.status).toBe('ok');
		expect(result.tagCount).toBe(3);
	});

	it('returns error on HTTP failure', async () => {
		const result = await refreshOracleTags({
			dbPath,
			fetchImpl: makeErrorFetch(500, 'Internal Server Error')
		});

		expect(result.status).toBe('error');
		expect(result.error).toMatch(/500/);
	});

	it('rejects concurrent in-process refresh', async () => {
		// Kick off a slow refresh (never resolves) to hold _refreshing = true
		let releaseFetch!: () => void;
		const blocker: typeof globalThis.fetch = () =>
			new Promise<Response>((resolve) => {
				releaseFetch = () =>
					resolve({
						ok: true,
						status: 200,
						headers: new Headers({ etag: '"v1"' }),
						json: async () => VALID_RESPONSE,
						text: async () => ''
					} as Response);
			});

		const first = refreshOracleTags({ dbPath, fetchImpl: blocker });
		// Give the first call time to set _refreshing = true
		await new Promise((r) => setTimeout(r, 10));

		// Second call should be immediately rejected (in-process guard)
		const second = await refreshOracleTags({ dbPath, fetchImpl: makeOkFetch(VALID_RESPONSE) });
		expect(second.status).toBe('already_running');

		// Clean up
		releaseFetch();
		await first;
	});
});

// ── Legacy schema migration ───────────────────────────────────────────────────

describe('legacy schema migration', () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = tempDbPath();
	});

	const LEGACY_TAGS = [
		{ id: 'old-1', label: 'Draw', oracle_ids: ['oid-x', 'oid-y'] },
		{ id: 'old-2', label: 'Ritual', oracle_ids: ['oid-z'] }
	];

	it('preserves all legacy data when the fetch fails (HTTP error)', async () => {
		createLegacyTagDb(dbPath, LEGACY_TAGS, '"legacy-etag"');

		const result = await refreshOracleTags({
			dbPath,
			fetchImpl: makeErrorFetch(503, 'Service Unavailable')
		});

		expect(result.status).toBe('error');
		expect(result.error).toMatch(/503/);

		// Legacy tables must be intact — tags and relations unchanged
		const db = new Database(dbPath);
		const tagCount = (
			db.prepare('SELECT COUNT(*) AS n FROM scryfall_oracle_tags').get() as { n: number }
		).n;
		const relCount = (
			db.prepare('SELECT COUNT(*) AS n FROM scryfall_oracle_tag_cards').get() as { n: number }
		).n;
		expect(tagCount).toBe(2);
		expect(relCount).toBe(3);

		// Legacy schema must still be intact (UNIQUE keyword present)
		const row = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='scryfall_oracle_tags'`)
			.get() as { sql: string };
		expect(row.sql).toMatch(/\bUNIQUE\b/);
		db.close();
	});

	it('omits If-None-Match even when an ETag is stored in the legacy DB', async () => {
		// Legacy DB has an ETag in metadata — it must be ignored on the legacy path
		createLegacyTagDb(dbPath, LEGACY_TAGS, '"legacy-etag"');

		const { fetchImpl, captured } = makeFetchCapturingHeaders(VALID_RESPONSE, '"new-etag"');
		await refreshOracleTags({ dbPath, fetchImpl });

		expect(captured).toHaveLength(1);
		const sentHeaders = (captured[0].headers ?? {}) as Record<string, string>;
		expect(sentHeaders['If-None-Match']).toBeUndefined();
	});

	it('retains the complete replacement dataset after a successful legacy migration', async () => {
		createLegacyTagDb(dbPath, LEGACY_TAGS);

		const newData = {
			object: 'list',
			data: [
				{ id: 'new-1', label: 'Ramp', oracle_ids: ['oid-a', 'oid-b'] },
				{ id: 'new-2', label: 'Removal', oracle_ids: ['oid-c'] },
				{ id: 'new-3', label: 'Counter', oracle_ids: ['oid-d'] }
			]
		};
		const result = await refreshOracleTags({
			dbPath,
			fetchImpl: makeOkFetch(newData, '"new-etag"')
		});

		expect(result.status).toBe('ok');
		expect(result.tagCount).toBe(3);
		expect(result.relationCount).toBe(4);

		const db = new Database(dbPath);
		const tags = db.prepare('SELECT id FROM scryfall_oracle_tags ORDER BY id').all() as {
			id: string;
		}[];
		expect(tags.map((t) => t.id)).toEqual(['new-1', 'new-2', 'new-3']);

		// Old tags must be gone
		const oldTag = db.prepare(`SELECT id FROM scryfall_oracle_tags WHERE id = 'old-1'`).get();
		expect(oldTag).toBeUndefined();
		db.close();
	});

	it('produces the corrected non-UNIQUE label schema after a successful migration', async () => {
		createLegacyTagDb(dbPath, LEGACY_TAGS);

		await refreshOracleTags({
			dbPath,
			fetchImpl: makeOkFetch(VALID_RESPONSE, '"new-etag"')
		});

		// Inspect the new schema in sqlite_master
		const db = new Database(dbPath);
		const row = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='scryfall_oracle_tags'`)
			.get() as { sql: string };
		expect(row.sql).not.toMatch(/\bUNIQUE\b/);
		expect(row.sql).toMatch(/COLLATE NOCASE/i);
		db.close();
	});

	it('preserves legacy data when validation fails (empty response)', async () => {
		createLegacyTagDb(dbPath, LEGACY_TAGS);

		// Validation will throw because data is empty
		const emptyResponse = { object: 'list', data: [] };
		const result = await refreshOracleTags({
			dbPath,
			fetchImpl: makeOkFetch(emptyResponse)
		});

		expect(result.status).toBe('error');
		expect(result.error).toMatch(/empty/i);

		// Legacy tables must be intact
		const db = new Database(dbPath);
		const count = (
			db.prepare('SELECT COUNT(*) AS n FROM scryfall_oracle_tags').get() as { n: number }
		).n;
		expect(count).toBe(2);
		// Schema must still be legacy (UNIQUE present — rollback restored it)
		const row = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='scryfall_oracle_tags'`)
			.get() as { sql: string };
		expect(row.sql).toMatch(/\bUNIQUE\b/);
		db.close();
	});
});

// ── Cross-process lock ────────────────────────────────────────────────────────

describe('cross-process advisory lock', () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = tempDbPath();
	});

	it('returns already_running without calling fetch when a live lock row exists', async () => {
		// Seed a DB that has the lock table with a live row (another "process" holds the lock)
		const db = new Database(dbPath);
		db.exec(`
			CREATE TABLE scryfall_tag_metadata (
				kind TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL,
				etag TEXT, tag_count INTEGER NOT NULL DEFAULT 0, relation_count INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE scryfall_refresh_lock (
				kind TEXT PRIMARY KEY, locked_at INTEGER NOT NULL, pid INTEGER NOT NULL
			);
		`);
		// Insert a lock held by a different PID with a recent timestamp (not stale)
		db.prepare(
			`INSERT INTO scryfall_refresh_lock (kind, locked_at, pid) VALUES ('oracle', ?, ?)`
		).run(Date.now(), process.pid + 9999); // different PID so releaseLock won't clear it
		db.close();

		let fetchCalled = false;
		const fetchImpl: typeof globalThis.fetch = async () => {
			fetchCalled = true;
			return {} as Response;
		};

		const result = await refreshOracleTags({ dbPath, fetchImpl });
		expect(result.status).toBe('already_running');
		expect(fetchCalled).toBe(false);
	});

	it('reclaims a stale lock and proceeds with the refresh', async () => {
		// Seed a DB with a stale lock (locked_at more than LOCK_STALE_MS ago)
		const staleLockTime = Date.now() - LOCK_STALE_MS - 60_000; // 1 min past the threshold
		const db = new Database(dbPath);
		db.exec(`
			CREATE TABLE scryfall_tag_metadata (
				kind TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL,
				etag TEXT, tag_count INTEGER NOT NULL DEFAULT 0, relation_count INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE scryfall_refresh_lock (
				kind TEXT PRIMARY KEY, locked_at INTEGER NOT NULL, pid INTEGER NOT NULL
			);
		`);
		db.prepare(
			`INSERT INTO scryfall_refresh_lock (kind, locked_at, pid) VALUES ('oracle', ?, ?)`
		).run(staleLockTime, process.pid + 9999);
		db.close();

		const result = await refreshOracleTags({
			dbPath,
			fetchImpl: makeOkFetch(VALID_RESPONSE, '"etag-fresh"')
		});

		// Stale lock was cleared; refresh proceeds successfully
		expect(result.status).toBe('ok');
		expect(result.tagCount).toBe(2);
	});
});
