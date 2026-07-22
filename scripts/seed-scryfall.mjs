#!/usr/bin/env node
/**
 * scripts/seed-scryfall.mjs
 *
 * Seeds the local SQLite Scryfall cache (scryfall.db) from scryfall-bulk.json.
 *
 * SQLite inserts are synchronous. Uses event-based streaming (stream.on('data')
 * + pause/resume) to avoid the for-await hang that affects fs.ReadStream.
 * Typical time: ~15–30 seconds for all 280k cards.
 *
 * Usage:  pnpm scryfall:seed
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BULK_PATH = path.join(ROOT, 'scryfall-bulk.json');
const BATCH_SIZE = 500;
const CHUNK_SIZE = 512 * 1024; // 512 KB per stream chunk

// ── .env ──────────────────────────────────────────────────────────────────────
{
	const p = path.join(ROOT, '.env');
	if (fs.existsSync(p)) {
		for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
			const t = line.trim();
			if (!t || t.startsWith('#')) continue;
			const eq = t.indexOf('=');
			if (eq < 0) continue;
			const k = t.slice(0, eq).trim();
			const v = t
				.slice(eq + 1)
				.trim()
				.replace(/^["']|["']$/g, '');
			if (!process.env[k]) process.env[k] = v;
		}
	}
}

const DB_PATH = process.env.SCRYFALL_DB_PATH ?? path.join(ROOT, 'scryfall.db');

console.log('='.repeat(64));
console.log('  Scryfall → SQLite seed');
console.log('='.repeat(64));
console.log('  DB  :', DB_PATH);
console.log('  File:', BULK_PATH);
console.log('  Batch:', BATCH_SIZE, '  Chunk:', CHUNK_SIZE / 1024, 'KB');
console.log('='.repeat(64), '\n');

if (!fs.existsSync(BULK_PATH)) {
	console.error('FATAL: file not found:', BULK_PATH);
	console.error('Download "Default Cards" from https://scryfall.com/docs/api/bulk-data');
	process.exit(1);
}
console.log('  Bulk file:', (fs.statSync(BULK_PATH).size / 1024 / 1024).toFixed(1), 'MB');
console.log('  DB path  :', DB_PATH, '\n');

// ── SQLite setup ──────────────────────────────────────────────────────────────
console.log('[db] Opening SQLite database...');
const db = new Database(DB_PATH);

// Phase 1: table + original indexes only — safe against existing old DBs.
db.exec(`
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
`);

// Phase 2: ALTER TABLE for new columns — no-op when they already exist.
{
	const existingCols = db
		.prepare('PRAGMA table_info(scryfall_cache)')
		.all()
		.map((r) => r.name);
	const newCols = [
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
	for (const [col, type] of newCols) {
		if (!existingCols.includes(col)) {
			db.exec(`ALTER TABLE scryfall_cache ADD COLUMN ${col} ${type}`);
			console.log(`[db] Migrated: added column ${col}`);
		}
	}
}

// Phase 3: indexes on migrated columns — must run after ALTER TABLE.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sc_oracle ON scryfall_cache(oracle_id);
`);

const { existing } = db.prepare('SELECT COUNT(*) AS existing FROM scryfall_cache').get();
console.log('[db] Existing rows:', Number(existing).toLocaleString());
console.log('[db] SQLite ready.\n');

// ── Prepared insert statement ─────────────────────────────────────────────────
const insertStmt = db.prepare(`
  INSERT OR REPLACE INTO scryfall_cache
    (id, name, set_code, collector_number, type_line, mana_cost, cmc,
     oracle_text, image_uri, back_image_uri, price_usd, price_usd_foil, last_updated,
     oracle_id, colors, color_identity, rarity, edhrec_rank, legalities,
     power, toughness, loyalty, keywords, produced_mana, artist, flavor_text,
     watermark, released_at, printing_metadata)
  VALUES
    (@id, @name, @set_code, @collector_number, @type_line, @mana_cost, @cmc,
     @oracle_text, @image_uri, @back_image_uri, @price_usd, @price_usd_foil, @last_updated,
     @oracle_id, @colors, @color_identity, @rarity, @edhrec_rank, @legalities,
     @power, @toughness, @loyalty, @keywords, @produced_mana, @artist, @flavor_text,
     @watermark, @released_at, @printing_metadata)
`);

// ── Batch insert via transaction (far faster than individual inserts) ──────────
function insertBatch(batch, batchNum, scanned) {
	const lo = ((batchNum - 1) * BATCH_SIZE + 1).toLocaleString().padStart(7);
	const hi = scanned.toLocaleString().padStart(7);
	process.stdout.write(`[seed] Batch ${String(batchNum).padStart(5)}: cards ${lo}–${hi} ... `);
	const t = Date.now();

	let ins = 0;
	db.transaction(() => {
		for (const row of batch) ins += insertStmt.run(row).changes;
	})();

	const skip = batch.length - ins;
	process.stdout.write(
		`${String(ins).padStart(4)} new  ${String(skip).padStart(4)} skip  (${Date.now() - t}ms)\n`
	);
	return { inserted: ins, skipped: skip };
}

// ── Map a raw Scryfall card to our DB columns ─────────────────────────────────
// Mirror of mapToRow() in src/lib/server/scryfall.ts — keep both in sync.
function mapCard(c) {
	const faces = c.card_faces ?? [];
	const image_uri = c.image_uris?.normal ?? faces[0]?.image_uris?.normal ?? null;
	const back_image_uri =
		!c.image_uris?.normal && faces.length >= 2 ? (faces[1]?.image_uris?.normal ?? null) : null;

	// type_line: top-level when present; otherwise join non-empty face type lines
	const type_line =
		c.type_line !== undefined
			? c.type_line
			: faces
					.map((f) => f.type_line ?? '')
					.filter(Boolean)
					.join(' // ') || '';

	// mana_cost: top-level when present; otherwise join non-empty face costs
	const mana_cost =
		c.mana_cost !== undefined
			? c.mana_cost
			: faces
					.map((f) => f.mana_cost ?? '')
					.filter(Boolean)
					.join(' // ');

	// oracle_text: top-level when present; otherwise join non-empty face texts
	const oracle_text =
		c.oracle_text !== undefined
			? c.oracle_text
			: faces
					.map((f) => f.oracle_text ?? '')
					.filter(Boolean)
					.join('\n//\n') || null;
	const faceValue = (topLevel, key) =>
		topLevel ??
		(faces
			.map((face) => face[key] ?? '')
			.filter(Boolean)
			.join(' // ') ||
			null);
	const colorIndicator = c.color_indicator ?? [
		...new Set(faces.flatMap((face) => face.color_indicator ?? []))
	];

	// colors: top-level when present (even []); otherwise deduplicated union of face colors
	let colors_json;
	if (Array.isArray(c.colors)) {
		colors_json = JSON.stringify(c.colors);
	} else if (faces.length > 0) {
		const seen = new Set();
		for (const face of faces) for (const ch of face.colors ?? []) seen.add(ch);
		colors_json = JSON.stringify(Array.from(seen));
	} else {
		colors_json = '[]';
	}

	return {
		id: c.id,
		name: c.name,
		set_code: c.set,
		collector_number: c.collector_number,
		type_line,
		mana_cost,
		cmc: typeof c.cmc === 'number' ? c.cmc : 0,
		oracle_text,
		image_uri,
		back_image_uri,
		price_usd: c.prices?.usd ? parseFloat(c.prices.usd) : null,
		price_usd_foil: c.prices?.usd_foil ? parseFloat(c.prices.usd_foil) : null,
		last_updated: Date.now(),
		oracle_id: c.oracle_id ?? null,
		colors: colors_json,
		color_identity: Array.isArray(c.color_identity) ? JSON.stringify(c.color_identity) : null,
		rarity: c.rarity ?? null,
		edhrec_rank: typeof c.edhrec_rank === 'number' ? c.edhrec_rank : null,
		legalities: c.legalities ? JSON.stringify(c.legalities) : null,
		power: faceValue(c.power, 'power'),
		toughness: faceValue(c.toughness, 'toughness'),
		loyalty: faceValue(c.loyalty, 'loyalty'),
		keywords: Array.isArray(c.keywords) ? JSON.stringify(c.keywords) : null,
		produced_mana: Array.isArray(c.produced_mana) ? JSON.stringify(c.produced_mana) : null,
		artist: faceValue(c.artist, 'artist'),
		flavor_text: faceValue(c.flavor_text, 'flavor_text'),
		watermark: c.watermark ?? null,
		released_at: c.released_at ?? null,
		printing_metadata: JSON.stringify({
			lang: c.lang ?? null,
			games: c.games ?? [],
			finishes: c.finishes ?? [],
			frame: c.frame ?? null,
			frameEffects: c.frame_effects ?? [],
			layout: c.layout ?? null,
			setName: c.set_name ?? null,
			setType: c.set_type ?? null,
			promo: c.promo ?? false,
			promoTypes: c.promo_types ?? [],
			reprint: c.reprint ?? false,
			reserved: c.reserved ?? false,
			digital: c.digital ?? false,
			fullArt: c.full_art ?? false,
			textless: c.textless ?? false,
			oversized: c.oversized ?? false,
			variation: c.variation ?? false,
			highresImage: c.highres_image ?? false,
			securityStamp: c.security_stamp ?? null,
			borderColor: c.border_color ?? null,
			booster: c.booster ?? false,
			storySpotlight: c.story_spotlight ?? false,
			printedName: c.printed_name ?? null,
			gameChanger: c.game_changer ?? false,
			colorIndicator,
			previewSource: c.preview?.source ?? null
		})
	};
}

// ── Main: stream file, parse per-chunk, insert synchronously ──────────────────
// Event-based approach: stream.pause() in the 'data' handler gives us explicit
// backpressure control. SQLite inserts are synchronous so stream.resume() is
// called in the same tick — no async gaps, no hang.

console.log('[seed] Opening file stream...\n');

const stream = fs.createReadStream(BULK_PATH, { highWaterMark: CHUNK_SIZE });

let buf = '',
	depth = 0,
	inStr = false,
	esc = false,
	start = -1;
let batch = [],
	batchNum = 0,
	scanned = 0,
	inserted = 0,
	skipped = 0,
	chunks = 0;
const t0 = Date.now();

try {
	await new Promise((resolve, reject) => {
		stream.on('data', (raw) => {
			stream.pause(); // hold until we're done with this chunk

			try {
				chunks++;
				// ── Key: start scanning from where we left off, not from 0 ──────────────
				// If the previous chunk ended mid-card, `buf` retains those bytes and
				// `depth`/`start`/`inStr`/`esc` capture the mid-parse state.  Starting
				// at i=0 would re-scan those bytes at the wrong depth and corrupt the
				// counter.  We only scan the *new* bytes; when a card IS found we trim
				// buf and restart from i=0 (trimmed buf is all-new data).
				const prevLen = buf.length;
				buf += raw.toString('utf8');

				// Synchronously scan the buffer for complete top-level JSON objects
				let i = prevLen; // ← start from the new bytes only
				while (i < buf.length) {
					const ch = buf[i];
					if (esc) {
						esc = false;
					} else if (inStr) {
						if (ch === '\\') esc = true;
						else if (ch === '"') inStr = false;
					} else {
						if (ch === '"') {
							inStr = true;
						} else if (ch === '{') {
							if (depth === 0) start = i;
							depth++;
						} else if (ch === '}') {
							depth--;
							if (depth === 0 && start >= 0) {
								try {
									const card = JSON.parse(buf.slice(start, i + 1));
									batch.push(mapCard(card));
									scanned++;
								} catch {
									/* skip malformed */
								}
								buf = buf.slice(i + 1);
								i = -1;
								start = -1;
							}
						}
					}
					i++;
				}
				if (start === -1 && depth === 0) buf = '';

				// Insert when batch is full — fully synchronous
				if (batch.length >= BATCH_SIZE) {
					batchNum++;
					const r = insertBatch(batch, batchNum, scanned);
					inserted += r.inserted;
					skipped += r.skipped;
					batch = [];

					if (batchNum % 50 === 0) {
						const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
						const rate = Math.round(scanned / ((Date.now() - t0) / 1000));
						const pct = ((scanned / 100000) * 100).toFixed(1); // ~100k cards in default bulk
						console.log(
							`\n  ── ${pct}% | ${scanned.toLocaleString()} scanned | ${inserted.toLocaleString()} new | ${elapsed}s | ~${rate.toLocaleString()}/s ──\n`
						);
					}
				}
			} catch (err) {
				console.error('[data handler error]', err);
				stream.destroy();
				reject(err);
				return;
			}

			stream.resume(); // ready for next chunk
		});

		stream.on('end', () => {
			try {
				// Flush remaining cards
				if (batch.length > 0) {
					batchNum++;
					const r = insertBatch(batch, batchNum, scanned);
					inserted += r.inserted;
					skipped += r.skipped;
				}
				resolve();
			} catch (err) {
				reject(err);
			}
		});

		stream.on('error', reject);
	});
} finally {
	db.close();
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\n' + '='.repeat(64));
console.log('  Done!');
console.log(`  Scanned  : ${scanned.toLocaleString()}`);
console.log(`  Inserted : ${inserted.toLocaleString()} (new cards)`);
console.log(`  Skipped  : ${skipped.toLocaleString()} (already existed)`);
console.log(`  Time     : ${elapsed}s  (${chunks} chunks read)`);
console.log(`  DB       : ${DB_PATH}`);
console.log('='.repeat(64));
