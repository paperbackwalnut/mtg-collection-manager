import * as scryfall from './db/scryfall-sqlite';
import type { ScryfallRow } from './db/scryfall-sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';

const SCRYFALL_BASE = 'https://api.scryfall.com';

const FETCH_HEADERS = {
	'User-Agent': 'MTGCollectionManager/1.0 (local application)',
	Accept: 'application/json'
};

interface ScryfallAPICard {
	id: string;
	oracle_id?: string;
	name: string;
	set: string;
	collector_number: string;
	type_line?: string;
	mana_cost?: string;
	cmc?: number;
	oracle_text?: string;
	colors?: string[];
	color_identity?: string[];
	rarity?: string;
	edhrec_rank?: number;
	legalities?: Record<string, string>;
	power?: string;
	toughness?: string;
	loyalty?: string;
	keywords?: string[];
	produced_mana?: string[];
	artist?: string;
	flavor_text?: string;
	watermark?: string;
	released_at?: string;
	lang?: string;
	games?: string[];
	finishes?: string[];
	frame?: string;
	frame_effects?: string[];
	layout?: string;
	set_name?: string;
	set_type?: string;
	promo?: boolean;
	promo_types?: string[];
	reprint?: boolean;
	reserved?: boolean;
	digital?: boolean;
	full_art?: boolean;
	textless?: boolean;
	oversized?: boolean;
	variation?: boolean;
	highres_image?: boolean;
	security_stamp?: string;
	border_color?: string;
	booster?: boolean;
	story_spotlight?: boolean;
	printed_name?: string;
	game_changer?: boolean;
	color_indicator?: string[];
	preview?: { source?: string };
	image_uris?: { normal?: string; small?: string };
	card_faces?: Array<{
		oracle_id?: string;
		type_line?: string;
		mana_cost?: string;
		oracle_text?: string;
		colors?: string[];
		color_indicator?: string[];
		power?: string;
		toughness?: string;
		loyalty?: string;
		artist?: string;
		flavor_text?: string;
		image_uris?: { normal?: string };
	}>;
	prices?: { usd?: string | null; usd_foil?: string | null };
}

/** Map a raw Scryfall API card to a SQLite row (snake_case). */
export function mapToRow(c: ScryfallAPICard): ScryfallRow {
	const faces = c.card_faces ?? [];
	const faceOracleIds = new Set(
		faces.map((face) => face.oracle_id).filter((id): id is string => !!id)
	);
	const oracle_id =
		c.oracle_id ?? (faceOracleIds.size === 1 ? faceOracleIds.values().next().value : null);
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
	const faceValue = (
		topLevel: string | undefined,
		key: 'power' | 'toughness' | 'loyalty' | 'artist' | 'flavor_text'
	): string | null =>
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
	let colors_json: string;
	if (Array.isArray(c.colors)) {
		colors_json = JSON.stringify(c.colors);
	} else if (faces.length > 0) {
		const seen = new Set<string>();
		for (const face of faces) {
			for (const ch of face.colors ?? []) seen.add(ch);
		}
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
		cmc: c.cmc ?? 0,
		oracle_text,
		image_uri,
		back_image_uri,
		price_usd: c.prices?.usd ? parseFloat(c.prices.usd) : null,
		price_usd_foil: c.prices?.usd_foil ? parseFloat(c.prices.usd_foil) : null,
		last_updated: Date.now(),
		oracle_id: oracle_id ?? null,
		colors: colors_json,
		color_identity: c.color_identity !== undefined ? JSON.stringify(c.color_identity) : null,
		rarity: c.rarity ?? null,
		edhrec_rank: c.edhrec_rank ?? null,
		legalities: c.legalities !== undefined ? JSON.stringify(c.legalities) : null,
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

// ── Bulk data helpers ─────────────────────────────────────────────────────────

interface BulkDataEntry {
	type: string;
	download_uri: string;
	size: number;
	updated_at: string;
}

async function fetchBulkManifest(): Promise<BulkDataEntry | null> {
	const res = await fetch(`${SCRYFALL_BASE}/bulk-data`, { headers: FETCH_HEADERS });
	if (!res.ok) throw new Error(`Bulk data manifest failed: ${res.status}`);
	const json = await res.json();
	return (json.data as BulkDataEntry[]).find((d) => d.type === 'default_cards') ?? null;
}

/**
 * Streaming JSON array parser — yields top-level objects from a JSON array stream
 * one at a time, without holding the full file in memory.
 *
 * NOTE: Only use the yielded cards synchronously (no awaits between next() calls)
 * to avoid the Node.js ReadStream backpressure hang where awaiting inside a
 * for-await loop over an async generator stalls the underlying stream iterator.
 */
async function* streamJsonArray(readable: NodeJS.ReadableStream): AsyncGenerator<ScryfallAPICard> {
	let buffer = '';
	let depth = 0;
	let inString = false;
	let escape = false;
	let objectStart = -1;

	for await (const raw of readable) {
		buffer += (raw as Buffer).toString('utf8');
		let i = 0;
		while (i < buffer.length) {
			const ch = buffer[i];
			if (escape) {
				escape = false;
			} else if (inString) {
				if (ch === '\\') escape = true;
				else if (ch === '"') inString = false;
			} else {
				if (ch === '"') {
					inString = true;
				} else if (ch === '{') {
					if (depth === 0) objectStart = i;
					depth++;
				} else if (ch === '}') {
					depth--;
					if (depth === 0 && objectStart >= 0) {
						try {
							yield JSON.parse(buffer.slice(objectStart, i + 1)) as ScryfallAPICard;
						} catch {
							// malformed object — skip it
						}
						buffer = buffer.slice(i + 1);
						i = -1;
						objectStart = -1;
					}
				}
			}
			i++;
		}
		if (objectStart === -1 && depth === 0) buffer = '';
	}
}

/** Local bulk file path — drop scryfall-bulk.json in project root to avoid downloads. */
const LOCAL_BULK_PATH = path.resolve(process.cwd(), 'scryfall-bulk.json');

async function openBulkStream(): Promise<NodeJS.ReadableStream> {
	if (fs.existsSync(LOCAL_BULK_PATH)) {
		const stat = fs.statSync(LOCAL_BULK_PATH);
		console.log(
			`Using local bulk file: ${LOCAL_BULK_PATH} (${Math.round(stat.size / 1024 / 1024)} MB)`
		);
		return fs.createReadStream(LOCAL_BULK_PATH);
	}

	console.log('No local scryfall-bulk.json found — fetching manifest for streaming download…');
	const manifest = await fetchBulkManifest();
	if (!manifest) throw new Error('Could not find default_cards in Scryfall bulk data manifest');

	const sizeMB = Math.round(manifest.size / 1024 / 1024);
	console.log(`Streaming Scryfall default_cards (~${sizeMB} MB, updated ${manifest.updated_at})…`);

	const res = await fetch(manifest.download_uri, { headers: FETCH_HEADERS });
	if (!res.ok) throw new Error(`Bulk data download failed: ${res.status}`);
	if (!res.body) throw new Error('Bulk data response has no body');

	return Readable.fromWeb(res.body as import('stream/web').ReadableStream);
}

// ── Bulk enrichment (primary path for large collections) ─────────────────────

/**
 * Enrich cards from Scryfall's default_cards bulk data.
 * Checks SQLite cache first; only streams the bulk file for uncached cards.
 * Returns a map of "setCode:collectorNumber" → Scryfall UUID for matched cards.
 */
export async function enrichFromBulkData(
	identifiers: Array<{ setCode: string; collectorNumber: string }>
): Promise<{
	result: Map<string, string>;
	notFound: Array<{ setCode: string; collectorNumber: string }>;
}> {
	const result = new Map<string, string>();
	if (identifiers.length === 0) return { result, notFound: [] };

	// Check SQLite cache first (synchronous, instant)
	const cachedKeys = new Map<string, string>();
	for (const ident of identifiers) {
		const row = scryfall.getBySetColl(ident.setCode, ident.collectorNumber);
		if (row) cachedKeys.set(`${ident.setCode}:${ident.collectorNumber}`, row.id);
	}

	const uncached = identifiers.filter((i) => !cachedKeys.has(`${i.setCode}:${i.collectorNumber}`));
	for (const ident of identifiers) {
		const id = cachedKeys.get(`${ident.setCode}:${ident.collectorNumber}`);
		if (id) result.set(`${ident.setCode}:${ident.collectorNumber}`, id);
	}

	if (uncached.length === 0) return { result, notFound: [] };

	const wantedKeys = new Set(uncached.map((i) => `${i.setCode}:${i.collectorNumber}`));
	console.log(`Bulk enrich: ${uncached.length} uncached cards. Opening bulk stream…`);

	const stream = await openBulkStream();
	let scanned = 0;
	let matched = 0;

	// SQLite insert is synchronous — no await in this loop, so no stream stall
	for await (const card of streamJsonArray(stream)) {
		scanned++;
		const key = `${card.set}:${card.collector_number}`;
		if (wantedKeys.has(key)) {
			scryfall.upsert(mapToRow(card));
			result.set(key, card.id);
			wantedKeys.delete(key);
			matched++;
			if (wantedKeys.size === 0) break;
		}
	}

	console.log(
		`Bulk enrich: scanned ${scanned.toLocaleString()} cards, matched ${matched}/${uncached.length}`
	);

	const notFound = uncached.filter((i) => !result.has(`${i.setCode}:${i.collectorNumber}`));
	if (notFound.length > 0) {
		console.log(`${notFound.length} cards not found in bulk data (tokens/promos/alt editions)`);
	}

	return { result, notFound };
}

// ── Batch API (for small lookups — deck imports, single cards) ────────────────

const MIN_MS_BETWEEN_REQUESTS = 300;
let lastRequestAt = 0;

async function rateLimitWait() {
	const now = Date.now();
	const since = now - lastRequestAt;
	if (since < MIN_MS_BETWEEN_REQUESTS) {
		await new Promise((r) => setTimeout(r, MIN_MS_BETWEEN_REQUESTS - since));
	}
	lastRequestAt = Date.now();
}

async function scryfallCollection(identifiers: object[], retries = 2): Promise<ScryfallAPICard[]> {
	await rateLimitWait();
	const res = await fetch(`${SCRYFALL_BASE}/cards/collection`, {
		method: 'POST',
		headers: { ...FETCH_HEADERS, 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifiers })
	});

	if (res.status === 429) {
		if (retries > 0) {
			console.warn(`Scryfall 429 — waiting 65s (${retries} retries left)`);
			await new Promise((r) => setTimeout(r, 65_000));
			return scryfallCollection(identifiers, retries - 1);
		}
		console.error('Scryfall rate limited, out of retries');
		return [];
	}
	if (!res.ok) {
		console.error('Scryfall collection fetch failed:', res.status, await res.text());
		return [];
	}
	const data = await res.json();
	return data.data ?? [];
}

/**
 * Enrich a small set of cards via the batch collection API.
 * Use this for deck imports (≤few hundred cards). Use enrichFromBulkData for collections.
 */
export async function enrichByIdentifiers(
	identifiers: Array<{ setCode: string; collectorNumber: string }>
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	if (identifiers.length === 0) return result;

	const unique = Array.from(
		new Map(identifiers.map((i) => [`${i.setCode}:${i.collectorNumber}`, i])).values()
	);

	// Check SQLite cache (synchronous)
	const cachedKeys = new Map<string, string>();
	for (const ident of unique) {
		const row = scryfall.getBySetColl(ident.setCode, ident.collectorNumber);
		// Only treat as a good hit if it has imageUri or typeLine (guards against old partial rows)
		if (row && (row.image_uri || row.type_line)) {
			cachedKeys.set(`${ident.setCode}:${ident.collectorNumber}`, row.id);
		}
	}
	const uncached = unique.filter((i) => !cachedKeys.has(`${i.setCode}:${i.collectorNumber}`));

	for (const ident of unique) {
		const id = cachedKeys.get(`${ident.setCode}:${ident.collectorNumber}`);
		if (id) result.set(`${ident.setCode}:${ident.collectorNumber}`, id);
	}

	for (let i = 0; i < uncached.length; i += 75) {
		const batch = uncached.slice(i, i + 75);
		const cards = await scryfallCollection(
			batch.map(({ setCode, collectorNumber }) => ({
				set: setCode,
				collector_number: collectorNumber
			}))
		);
		for (const card of cards) {
			scryfall.upsert(mapToRow(card));
			result.set(`${card.set}:${card.collector_number}`, card.id);
		}
	}

	return result;
}

/**
 * Refresh exact Scryfall printings by UUID and return their Oracle identities.
 * Used for collection rows whose cached printing lacks Oracle metadata.
 */
export async function enrichOracleIdsByScryfallId(ids: string[]): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	const unique = [...new Set(ids.filter(Boolean))];

	for (let index = 0; index < unique.length; index += 75) {
		const cards = await scryfallCollection(unique.slice(index, index + 75).map((id) => ({ id })));
		for (const card of cards) {
			const row = mapToRow(card);
			scryfall.upsert(row);
			if (row.oracle_id) result.set(row.id, row.oracle_id);
		}
	}

	return result;
}

/** Fuzzy name lookup — checks SQLite cache first, then Scryfall API. */
export async function enrichByName(name: string): Promise<string | null> {
	const cached = scryfall.getByName(name);
	if (cached) return cached.id;

	await rateLimitWait();
	const res = await fetch(`${SCRYFALL_BASE}/cards/named?fuzzy=${encodeURIComponent(name)}`, {
		headers: FETCH_HEADERS
	});
	if (res.status === 429) {
		console.warn('Scryfall 429 on name lookup, skipping:', name);
		return null;
	}
	if (!res.ok) return null;

	const card: ScryfallAPICard = await res.json();
	scryfall.upsert(mapToRow(card));
	return card.id;
}

// ── Price refresh ─────────────────────────────────────────────────────────────

/**
 * Re-read bulk data and update prices for all SQLite-cached cards.
 * Uses streaming — works with local file or live download.
 */
export async function refreshPricesFromBulkData(): Promise<number> {
	const cachedIds = new Set(scryfall.getAllIds());
	if (cachedIds.size === 0) return 0;

	console.log(
		`Price refresh: streaming bulk data for ${cachedIds.size.toLocaleString()} cached cards…`
	);
	const stream = await openBulkStream();

	let updated = 0;
	// SQLite updates are synchronous — no await in loop, no stream stall
	for await (const card of streamJsonArray(stream)) {
		if (!cachedIds.has(card.id)) continue;
		scryfall.updatePrices(
			card.id,
			card.prices?.usd ? parseFloat(card.prices.usd) : null,
			card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null
		);
		updated++;
	}

	console.log(`Price refresh complete: updated ${updated} cards`);
	return updated;
}

/** Legacy batch API price refresh — falls back to refreshPricesFromBulkData for large caches. */
export async function refreshPrices(olderThanMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
	const cutoff = Date.now() - olderThanMs;
	const all = scryfall.getAllMeta();
	const toRefresh = all.filter((r) => !r.lastUpdated || r.lastUpdated < cutoff);
	if (toRefresh.length === 0) return 0;

	if (toRefresh.length > 200) return refreshPricesFromBulkData();

	for (let i = 0; i < toRefresh.length; i += 75) {
		const batch = toRefresh.slice(i, i + 75);
		const cards = await scryfallCollection(batch.map((c) => ({ id: c.id })));
		for (const card of cards) {
			scryfall.updatePrices(
				card.id,
				card.prices?.usd ? parseFloat(card.prices.usd) : null,
				card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null
			);
		}
	}
	return toRefresh.length;
}

// ── Seed (called from web UI or CLI) ─────────────────────────────────────────

/**
 * Seed the SQLite cache from a bulk JSON stream.
 * INSERT OR IGNORE — safe to re-run; existing rows are skipped.
 * For price refreshes use refreshPricesFromBulkData() instead.
 *
 * Uses event-based streaming (stream.pause/resume) instead of for-await to
 * avoid the Node.js ReadStream hang where synchronous SQLite inserts between
 * async generator next() calls stall the underlying stream iterator.
 */
export async function seedScryfallCache(
	stream: NodeJS.ReadableStream
): Promise<{ inserted: number; skipped: number; total: number }> {
	const BATCH_SIZE = 500;

	console.log('[Scryfall seed] Stream open — beginning JSON parse…');

	return new Promise((resolve, reject) => {
		let buffer = '',
			depth = 0,
			inStr = false,
			esc = false,
			objectStart = -1;
		let batch: ScryfallRow[] = [],
			total = 0,
			inserted = 0;

		stream.on('data', (raw: Buffer) => {
			(stream as NodeJS.ReadableStream & { pause(): void; resume(): void }).pause();

			const prevLen = buffer.length;
			buffer += raw.toString('utf8');

			// Scan only the newly-appended bytes (prevLen…end).
			// If a card straddles two chunks, depth/objectStart/inStr/esc already
			// reflect the mid-parse state — restarting at 0 would corrupt them.
			let i = prevLen;
			while (i < buffer.length) {
				const ch = buffer[i];
				if (esc) {
					esc = false;
				} else if (inStr) {
					if (ch === '\\') esc = true;
					else if (ch === '"') inStr = false;
				} else {
					if (ch === '"') {
						inStr = true;
					} else if (ch === '{') {
						if (depth === 0) objectStart = i;
						depth++;
					} else if (ch === '}') {
						depth--;
						if (depth === 0 && objectStart >= 0) {
							try {
								batch.push(
									mapToRow(JSON.parse(buffer.slice(objectStart, i + 1)) as ScryfallAPICard)
								);
								total++;
							} catch {
								/* skip malformed */
							}
							buffer = buffer.slice(i + 1);
							i = -1;
							objectStart = -1;
						}
					}
				}
				i++;
			}
			if (objectStart === -1 && depth === 0) buffer = '';

			if (batch.length >= BATCH_SIZE) {
				inserted += scryfall.insertBatch(batch);
				batch = [];
				if (total % 10000 === 0) {
					process.stdout.write(
						`[Scryfall seed] ${total.toLocaleString()} scanned, ${inserted.toLocaleString()} inserted\n`
					);
				}
			}

			(stream as NodeJS.ReadableStream & { pause(): void; resume(): void }).resume();
		});

		stream.on('end', () => {
			if (batch.length > 0) inserted += scryfall.insertBatch(batch);
			const skipped = total - inserted;
			console.log(
				`[Scryfall seed] ✓ Done — ${inserted.toLocaleString()} inserted, ${skipped.toLocaleString()} skipped, ${total.toLocaleString()} total`
			);
			resolve({ inserted, skipped, total });
		});

		stream.on('error', reject);
	});
}
