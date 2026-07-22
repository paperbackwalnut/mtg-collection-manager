/**
 * src/lib/server/db/scryfall-sqlite.ts
 *
 * Local SQLite store for the Scryfall cache (~280k cards).
 * Lives at <project-root>/scryfall.db by default; override with SCRYFALL_DB_PATH.
 *
 * Why SQLite works well for this table:
 *   - Static reference data that rarely changes
 *   - Seeding 280k rows over a network took 5+ minutes; locally it takes ~15 seconds
 *   - Reads are in-process (microseconds), no round trip
 *   - Each machine seeds its own rebuildable copy; personal data stays in collection.db
 */

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ── Path ──────────────────────────────────────────────────────────────────────
// Defaults to <project-root>/scryfall.db; already covered by *.db in .gitignore.
// Set SCRYFALL_DB_PATH in .env to put it somewhere else (e.g. a Dropbox folder).
const DB_PATH =
	(typeof process !== 'undefined' && process.env.SCRYFALL_DB_PATH) ||
	path.join(process.cwd(), 'scryfall.db');

// ── Schema ────────────────────────────────────────────────────────────────────
// Phase 1 only: original 13 columns + original indexes.
// Safe to run against an old DB that already has the table — IF NOT EXISTS skips it.
// DO NOT add new columns or new-column indexes here; they go in migrateDb / DDL_INDEXES.
const DDL_TABLE = `
  CREATE TABLE IF NOT EXISTS scryfall_cache (
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
  CREATE INDEX IF NOT EXISTS idx_sc_set_coll ON scryfall_cache(set_code, collector_number);
  CREATE INDEX IF NOT EXISTS idx_sc_name     ON scryfall_cache(name);
`;

// Phase 2: ADD COLUMN for each new column — safe no-op when column already exists.
const NEW_COLS: [string, string][] = [
	['oracle_id', 'TEXT'],
	['colors', 'TEXT'],
	['color_identity', 'TEXT'],
	['rarity', 'TEXT'],
	['edhrec_rank', 'INTEGER'],
	['legalities', 'TEXT'],
	['power', 'TEXT'],
	['toughness', 'TEXT'],
	['loyalty', 'TEXT'],
	['keywords', 'TEXT'],
	['produced_mana', 'TEXT'],
	['artist', 'TEXT'],
	['flavor_text', 'TEXT'],
	['watermark', 'TEXT'],
	['released_at', 'TEXT'],
	['printing_metadata', 'TEXT']
];

function migrateDb(d: Database.Database): void {
	const existing = (d.prepare('PRAGMA table_info(scryfall_cache)').all() as { name: string }[]).map(
		(r) => r.name
	);
	for (const [col, type] of NEW_COLS) {
		if (!existing.includes(col)) {
			d.exec(`ALTER TABLE scryfall_cache ADD COLUMN ${col} ${type}`);
		}
	}
}

// Phase 3: indexes that reference migrated columns — must run AFTER migrateDb.
const DDL_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_sc_oracle ON scryfall_cache(oracle_id);
`;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ScryfallRow {
	id: string;
	name: string;
	set_code: string;
	collector_number: string;
	type_line: string;
	mana_cost: string;
	cmc: number;
	oracle_text: string | null;
	image_uri: string | null;
	back_image_uri: string | null;
	price_usd: number | null;
	price_usd_foil: number | null;
	last_updated: number;
	// New in Part 1
	oracle_id: string | null;
	colors: string | null; // JSON array, e.g. '["W","U"]'
	color_identity: string | null; // JSON array
	rarity: string | null;
	edhrec_rank: number | null;
	legalities: string | null; // JSON object, e.g. {"commander":"legal"}
	power: string | null;
	toughness: string | null;
	loyalty: string | null;
	keywords: string | null; // JSON array
	produced_mana: string | null; // JSON array
	artist: string | null;
	flavor_text: string | null;
	watermark: string | null;
	released_at: string | null; // YYYY-MM-DD
	printing_metadata: string | null; // JSON object: language, games, finishes, frame, flags
}

// ── Singleton DB + prepared statements ───────────────────────────────────────
let _db: Database.Database | null = null;

function db(): Database.Database {
	if (_db) return _db;
	_db = new Database(DB_PATH);
	_db.exec(DDL_TABLE); // phase 1: table + original indexes
	migrateDb(_db); // phase 2: ALTER TABLE for new columns
	_db.exec(DDL_INDEXES); // phase 3: indexes on migrated columns
	return _db;
}

/**
 * Open an initialized Scryfall DB.
 * Uses the singleton default DB when dbPath is omitted.
 * When dbPath is provided (e.g. in tests), opens a fresh connection each time.
 */
export function openDb(dbPath?: string): Database.Database {
	if (!dbPath) return db();
	const d = new Database(dbPath);
	d.exec(DDL_TABLE);
	migrateDb(d);
	d.exec(DDL_INDEXES);
	return d;
}

/** Thrown by filterByAST when required cache columns have not been populated. */
export class CacheNotReadyError extends Error {
	constructor(field: string, command = 'pnpm scryfall:seed') {
		super(`Scryfall cache needs refreshing to use ${field} filters. Run: ${command}`);
		this.name = 'CacheNotReadyError';
	}
}

// Lazy statement cache — prepared once, reused across calls
const COLS =
	'id, name, set_code, collector_number, type_line, mana_cost, cmc, oracle_text, image_uri, back_image_uri, price_usd, price_usd_foil, last_updated, oracle_id, colors, color_identity, rarity, edhrec_rank, legalities, power, toughness, loyalty, keywords, produced_mana, artist, flavor_text, watermark, released_at, printing_metadata';
const VALS =
	'@id, @name, @set_code, @collector_number, @type_line, @mana_cost, @cmc, @oracle_text, @image_uri, @back_image_uri, @price_usd, @price_usd_foil, @last_updated, @oracle_id, @colors, @color_identity, @rarity, @edhrec_rank, @legalities, @power, @toughness, @loyalty, @keywords, @produced_mana, @artist, @flavor_text, @watermark, @released_at, @printing_metadata';

type Stmts = ReturnType<typeof buildStmts>;
let _stmts: Stmts | null = null;

function buildStmts() {
	const d = db();
	return {
		bySetColl: d.prepare<[string, string]>(
			'SELECT * FROM scryfall_cache WHERE set_code = ? AND collector_number = ? LIMIT 1'
		),
		byId: d.prepare<[string]>('SELECT * FROM scryfall_cache WHERE id = ? LIMIT 1'),
		byName: d.prepare<[string]>('SELECT * FROM scryfall_cache WHERE name = ? LIMIT 1'),

		upsert: d.prepare<ScryfallRow>(
			`INSERT INTO scryfall_cache (${COLS}) VALUES (${VALS})
       ON CONFLICT(id) DO UPDATE SET
         price_usd      = excluded.price_usd,
         price_usd_foil = excluded.price_usd_foil,
         image_uri      = excluded.image_uri,
         type_line      = excluded.type_line,
         last_updated   = excluded.last_updated,
         oracle_id      = excluded.oracle_id,
         colors         = excluded.colors,
         color_identity = excluded.color_identity,
         rarity         = excluded.rarity,
         edhrec_rank    = excluded.edhrec_rank,
         legalities     = excluded.legalities,
         power          = excluded.power,
         toughness      = excluded.toughness,
         loyalty        = excluded.loyalty,
         keywords       = excluded.keywords,
         produced_mana  = excluded.produced_mana,
         artist         = excluded.artist,
         flavor_text    = excluded.flavor_text,
         watermark      = excluded.watermark,
         released_at    = excluded.released_at,
         printing_metadata = excluded.printing_metadata`
		),
		insertIgnore: d.prepare<ScryfallRow>(
			`INSERT OR REPLACE INTO scryfall_cache (${COLS}) VALUES (${VALS})`
		),
		updatePrices: d.prepare<[number | null, number | null, number, string]>(
			'UPDATE scryfall_cache SET price_usd = ?, price_usd_foil = ?, last_updated = ? WHERE id = ?'
		),

		// Autocomplete: distinct card names matching a prefix/substring
		searchNames: d.prepare<[string, number]>(
			`SELECT DISTINCT name FROM scryfall_cache WHERE name LIKE ? ORDER BY name LIMIT ?`
		),
		// All printings of a card, ordered by newest set first
		printings: d.prepare<[string]>(
			`SELECT * FROM scryfall_cache WHERE name = ? ORDER BY set_code, collector_number`
		),
		// Cheapest non-null price across all printings — MIN() skips NULLs automatically
		minPriceByName: d.prepare<[string]>(
			`SELECT MIN(price_usd) AS price_usd FROM scryfall_cache WHERE name = ?`
		),

		countAll: d.prepare<[]>('SELECT COUNT(*) AS total FROM scryfall_cache'),
		maxUpdated: d.prepare<[]>('SELECT MAX(last_updated) AS lastUpdated FROM scryfall_cache'),
		allIds: d.prepare<[]>('SELECT id FROM scryfall_cache'),
		allMeta: d.prepare<[]>('SELECT id, last_updated AS lastUpdated FROM scryfall_cache')
	};
}

function s(): Stmts {
	return (_stmts ??= buildStmts());
}

// ── Public API ────────────────────────────────────────────────────────────────

export function dbFilePath(): string {
	return DB_PATH;
}

export function dbExists(): boolean {
	return fs.existsSync(DB_PATH);
}

export function getStats(): { total: number; lastUpdated: number | null } {
	const { total } = s().countAll.get() as { total: number };
	const { lastUpdated } = s().maxUpdated.get() as { lastUpdated: number | null };
	return { total, lastUpdated };
}

// ── Lookups ───────────────────────────────────────────────────────────────────

export function getBySetColl(setCode: string, collectorNumber: string): ScryfallRow | undefined {
	return s().bySetColl.get(setCode, collectorNumber) as ScryfallRow | undefined;
}

export function getById(id: string): ScryfallRow | undefined {
	return s().byId.get(id) as ScryfallRow | undefined;
}

export function getByName(name: string): ScryfallRow | undefined {
	return s().byName.get(name) as ScryfallRow | undefined;
}

/**
 * Returns the cheapest non-null USD price across all printings of a card.
 * Uses MIN() which ignores NULL values, so it always returns a real price
 * if any printing has one — even if getByName() happened to return a NULL-price row.
 */
export function getMinPriceByName(name: string): number | null {
	const row = s().minPriceByName.get(name) as { price_usd: number | null } | undefined;
	return row?.price_usd ?? null;
}

/** Autocomplete: returns up to `limit` card names matching all query words (any order). */
export function searchNames(query: string, limit = 12): string[] {
	const escape = (w: string) => w.replace(/%/g, '\\%').replace(/_/g, '\\_');
	const words = query.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];

	if (words.length === 1) {
		const pattern = `%${escape(words[0])}%`;
		return (s().searchNames.all(pattern, limit) as { name: string }[]).map((r) => r.name);
	}

	// Multi-word: every word must appear somewhere in the name (any order)
	const conditions = words.map(() => 'name LIKE ?').join(' AND ');
	const stmt = db().prepare(
		`SELECT DISTINCT name FROM scryfall_cache WHERE ${conditions} ORDER BY name LIMIT ?`
	);
	const patterns = words.map((w) => `%${escape(w)}%`);
	return (stmt.all(...patterns, limit) as { name: string }[]).map((r) => r.name);
}

/** All printings of a card name, sorted by set+collector. */
export function getPrintings(name: string): ScryfallRow[] {
	return s().printings.all(name) as ScryfallRow[];
}

// ── Filter token types (used by shared parser in scryfall-search.ts) ─────────

export interface SearchToken {
	value: string;
	negate: boolean;
}

export interface MvToken {
	op: '=' | '>=' | '<=' | '>' | '<';
	val: number;
	negate: boolean;
}

/** One color token, e.g. c:WU → { chars: ['W','U'], negate: false } */
export interface ColorToken {
	chars: string[];
	negate: boolean;
}

export type SortField = 'name' | 'price' | 'edhrec';

function escapeLike(s: string): string {
	return s.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function negateMvOp(op: MvToken['op']): string {
	switch (op) {
		case '=':
			return '!=';
		case '>=':
			return '<';
		case '<=':
			return '>';
		case '>':
			return '<=';
		case '<':
			return '>=';
	}
}

/**
 * Returns scryfall IDs matching all given filter tokens, in sort order.
 * Called only when at least one filter is present — never returns empty due to
 * "no filters" (that check is the caller's responsibility).
 *
 * Color filtering uses the cached `colors` / `color_identity` JSON columns,
 * never mana_cost inference.
 */
export function getIdsByFilters(params: {
	names?: SearchToken[];
	types?: SearchToken[];
	oracle?: SearchToken[];
	mvOps?: MvToken[];
	sets?: SearchToken[];
	collectorNumbers?: SearchToken[];
	rarities?: SearchToken[];
	colors?: ColorToken[]; // c:/color: — containment, per-char AND
	colorIdentity?: ColorToken[]; // ci:/id:  — subset check
	sort?: SortField;
}): string[] {
	const conditions: string[] = [];
	const args: (string | number)[] = [];

	for (const { value, negate } of params.names ?? []) {
		conditions.push(negate ? `name NOT LIKE ? ESCAPE '\\'` : `name LIKE ? ESCAPE '\\'`);
		args.push(`%${escapeLike(value)}%`);
	}

	for (const { value, negate } of params.types ?? []) {
		conditions.push(negate ? `type_line NOT LIKE ? ESCAPE '\\'` : `type_line LIKE ? ESCAPE '\\'`);
		args.push(`%${escapeLike(value)}%`);
	}

	for (const { value, negate } of params.oracle ?? []) {
		conditions.push(
			negate
				? `(oracle_text IS NULL OR oracle_text NOT LIKE ? ESCAPE '\\')`
				: `oracle_text LIKE ? ESCAPE '\\'`
		);
		args.push(`%${escapeLike(value)}%`);
	}

	for (const { op, val, negate } of params.mvOps ?? []) {
		const actualOp = negate ? negateMvOp(op) : op;
		conditions.push(`cmc ${actualOp} ?`);
		args.push(val);
	}

	for (const { value, negate } of params.sets ?? []) {
		conditions.push(negate ? `set_code != ?` : `set_code = ?`);
		args.push(value.toLowerCase());
	}

	for (const { value, negate } of params.collectorNumbers ?? []) {
		conditions.push(negate ? `collector_number != ?` : `collector_number = ?`);
		args.push(value);
	}

	for (const { value, negate } of params.rarities ?? []) {
		conditions.push(negate ? `rarity != ?` : `rarity = ?`);
		args.push(value.toLowerCase());
	}

	// c:/color: — uses cached `colors` JSON array, never mana_cost
	for (const { chars, negate } of params.colors ?? []) {
		for (const c of chars) {
			if (c === 'C') {
				// Colorless: colors array is empty or null
				conditions.push(
					negate
						? `(colors IS NOT NULL AND json_array_length(colors) > 0)`
						: `(colors IS NULL OR json_array_length(colors) = 0)`
				);
			} else {
				conditions.push(
					negate
						? `NOT EXISTS (SELECT 1 FROM json_each(colors) WHERE value = ?)`
						: `EXISTS (SELECT 1 FROM json_each(colors) WHERE value = ?)`
				);
				args.push(c);
			}
		}
	}

	// ci:/id: — card's color identity must be a subset of the given colors
	for (const { chars, negate } of params.colorIdentity ?? []) {
		if (chars.length === 0) continue;
		const placeholders = chars.map(() => '?').join(', ');
		conditions.push(
			negate
				? `EXISTS (SELECT 1 FROM json_each(color_identity) WHERE value NOT IN (${placeholders}))`
				: `NOT EXISTS (SELECT 1 FROM json_each(color_identity) WHERE value NOT IN (${placeholders}))`
		);
		args.push(...chars);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	const sort = params.sort ?? 'name';
	const orderBy =
		sort === 'edhrec'
			? `ORDER BY CASE WHEN edhrec_rank IS NULL THEN 1 ELSE 0 END, edhrec_rank ASC`
			: sort === 'price'
				? `ORDER BY CASE WHEN price_usd IS NULL THEN 1 ELSE 0 END, price_usd ASC`
				: `ORDER BY name ASC`;

	const stmt = db().prepare(`SELECT DISTINCT id FROM scryfall_cache ${where} ${orderBy}`);
	return (stmt.all(...args) as { id: string }[]).map((r) => r.id);
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Upsert a single card, updating price/image/type on conflict (for live API responses). */
export function upsert(row: ScryfallRow): void {
	s().upsert.run(row);
}

/**
 * Bulk INSERT OR IGNORE — skips existing rows, wraps in a transaction.
 * Used by the seed script and seedScryfallCache().
 * Returns number of rows actually inserted.
 */
export function insertBatch(rows: ScryfallRow[]): number {
	const stmt = s().insertIgnore;
	let inserted = 0;
	db().transaction(() => {
		for (const row of rows) inserted += stmt.run(row).changes;
	})();
	return inserted;
}

export function updatePrices(
	id: string,
	priceUsd: number | null,
	priceUsdFoil: number | null
): void {
	s().updatePrices.run(priceUsd, priceUsdFoil, Date.now(), id);
}

/** All cached Scryfall IDs — used by bulk price refresh. */
export function getAllIds(): string[] {
	return (s().allIds.all() as { id: string }[]).map((r) => r.id);
}

/**
 * Batch lookup by Scryfall UUID.
 * Returns a Map<id, ScryfallRow> — missing IDs are simply absent from the map.
 * Uses a single WHERE id IN (...) query instead of N individual lookups.
 */
export function getByIds(ids: Iterable<string | null | undefined>): Map<string, ScryfallRow> {
	const idList = [...new Set([...ids].filter((id): id is string => !!id))];
	if (idList.length === 0) return new Map();

	const placeholders = idList.map(() => '?').join(',');
	const stmt = db().prepare(`SELECT * FROM scryfall_cache WHERE id IN (${placeholders})`);
	const rows = stmt.all(...idList) as ScryfallRow[];
	return new Map(rows.map((r) => [r.id, r]));
}

/** All cached rows' id + lastUpdated — used by legacy price refresh. */
export function getAllMeta(): { id: string; lastUpdated: number | null }[] {
	return s().allMeta.all() as { id: string; lastUpdated: number | null }[];
}
