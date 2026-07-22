import type { ParsedDeckCard } from '$lib/types';

// ── CSV parsing ──────────────────────────────────────────────────────────────

export interface MoxfieldRow {
	count: number;
	name: string;
	edition: string; // set code (e.g. "cmr")
	condition: string;
	language: string;
	foil: boolean;
	tags: string;
	collectorNumber: string;
	isProxy: boolean;
	purchasePrice: number | null;
}

function parseCSVLine(line: string): string[] {
	const fields: string[] = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (inQuotes && line[i + 1] === '"') {
				field += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (ch === ',' && !inQuotes) {
			fields.push(field);
			field = '';
		} else {
			field += ch;
		}
	}
	fields.push(field);
	return fields;
}

export function parseMoxfieldCSV(csvText: string): MoxfieldRow[] {
	const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
	if (lines.length < 2) return [];

	const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());

	const idx = (...names: string[]) =>
		names.reduce((found, name) => (found >= 0 ? found : header.indexOf(name)), -1);
	const col = {
		count: idx('count', 'qty', 'quantity'),
		name: idx('name'),
		edition: idx('edition', 'set', 'set code'),
		condition: idx('condition'),
		language: idx('language'),
		foil: idx('foil'),
		tags: idx('tags'),
		collectorNumber: idx('collector number', 'collector #', 'collector number #'),
		isProxy: idx('proxy'),
		purchasePrice: idx('purchase price')
	};
	if (col.count < 0 || col.name < 0 || col.edition < 0 || col.collectorNumber < 0) {
		return [];
	}

	const rows: MoxfieldRow[] = [];
	for (let i = 1; i < lines.length; i++) {
		const f = parseCSVLine(lines[i]);
		if (f.length < 3) continue;
		const count = Number.parseInt(f[col.count] ?? '', 10);
		if (!Number.isInteger(count) || count < 1) continue;
		const purchasePriceText = (f[col.purchasePrice] ?? '').trim();
		const parsedPurchasePrice =
			purchasePriceText === '' ? null : Number.parseFloat(purchasePriceText);
		rows.push({
			count,
			name: f[col.name]?.trim() ?? '',
			edition: (f[col.edition] ?? '').trim().toLowerCase(),
			condition: f[col.condition]?.trim() || 'NM',
			language: f[col.language]?.trim() || 'English',
			foil: ['true', 'yes', 'foil'].includes((f[col.foil] ?? '').trim().toLowerCase()),
			tags: (f[col.tags] ?? '').trim().replace(/;\s*/g, ','),
			collectorNumber: (f[col.collectorNumber] ?? '').trim(),
			isProxy: (f[col.isProxy] ?? '').toLowerCase() === 'true',
			purchasePrice:
				parsedPurchasePrice !== null && Number.isFinite(parsedPurchasePrice)
					? parsedPurchasePrice
					: null
		});
	}
	return rows.filter((r) => r.name && r.edition);
}

// ── Text decklist parsing ────────────────────────────────────────────────────

export function parseTextDecklist(text: string): ParsedDeckCard[] {
	const cards: ParsedDeckCard[] = [];
	let board: 'main' | 'side' | 'maybe' | 'commander' = 'main';

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;

		// Section headers
		if (line.startsWith('//') || line.startsWith('#')) {
			const lower = line.toLowerCase();
			if (lower.includes('sideboard') || lower.includes('side board')) board = 'side';
			else if (lower.includes('commander')) board = 'commander';
			else if (lower.includes('maybeboard') || lower.includes('maybe board')) board = 'maybe';
			else if (
				lower.includes('mainboard') ||
				lower.includes('main board') ||
				lower.includes('main deck')
			)
				board = 'main';
			continue;
		}

		// SB: prefix (MTGO sideboard format)
		let effectiveBoard = board;
		let effectiveLine = line;
		if (line.match(/^SB:\s*/i)) {
			effectiveBoard = 'side';
			effectiveLine = line.replace(/^SB:\s*/i, '');
		}

		// Parse: "4 Sol Ring (CMR) 319" or "4x Sol Ring" or "1 Command Tower"
		// Also handle "4 Sol Ring (CMR) #319"
		const match = effectiveLine.match(
			/^(\d+)[xX]?\s+(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)\s+#?(\w+))?$/
		);
		if (!match) continue;

		const qty = parseInt(match[1]);
		const name = match[2].trim();
		const setCode = match[3]?.toLowerCase() ?? undefined;
		const collectorNumber = match[4] ?? undefined;

		if (!name || qty < 1) continue;

		const isCommander = effectiveBoard === 'commander';
		cards.push({
			cardName: name,
			quantity: qty,
			setCode,
			collectorNumber,
			board: effectiveBoard,
			isCommander
		});
	}

	return cards;
}

// ── Moxfield deck API ────────────────────────────────────────────────────────

function extractDeckId(url: string): string | null {
	const match = url.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/);
	return match ? match[1] : null;
}

interface MoxfieldAPICard {
	quantity: number;
	card: {
		name: string;
		set: string;
		// Moxfield API has used both naming conventions across versions
		collector_number?: string;
		collectorNumber?: string;
		scryfall_id?: string;
		scryfallId?: string;
	};
}

interface MoxfieldDeckResponse {
	name: string;
	format?: string;
	publicUrl?: string;
	mainboard?: Record<string, MoxfieldAPICard>;
	sideboard?: Record<string, MoxfieldAPICard>;
	maybeboard?: Record<string, MoxfieldAPICard>;
	commanders?: Record<string, MoxfieldAPICard>;
	companions?: Record<string, MoxfieldAPICard>;
}

export async function fetchMoxfieldDeck(url: string): Promise<{
	name: string;
	format: string | null;
	commander: string | null;
	moxfieldUrl: string;
	cards: ParsedDeckCard[];
}> {
	const deckId = extractDeckId(url);
	if (!deckId) throw new Error('Could not extract deck ID from URL');

	const res = await fetch(`https://api.moxfield.com/v2/decks/all/${deckId}`, {
		headers: {
			'User-Agent': 'MTGCollectionManager/1.0 (local application)',
			Accept: 'application/json'
		}
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Moxfield API returned ${res.status}: ${body.slice(0, 200)}`);
	}

	const data: MoxfieldDeckResponse = await res.json();
	const cards: ParsedDeckCard[] = [];

	const zones: Array<
		[string, Record<string, MoxfieldAPICard> | undefined, 'main' | 'side' | 'maybe' | 'commander']
	> = [
		['mainboard', data.mainboard, 'main'],
		['sideboard', data.sideboard, 'side'],
		['maybeboard', data.maybeboard, 'maybe'],
		['commanders', data.commanders, 'commander'],
		['companions', data.companions, 'side']
	];

	const commanders: string[] = [];

	for (const [, zone, board] of zones) {
		if (!zone) continue;
		for (const entry of Object.values(zone)) {
			const isCommander = board === 'commander';
			if (isCommander) commanders.push(entry.card.name);
			cards.push({
				cardName: entry.card.name,
				quantity: entry.quantity,
				setCode: entry.card.set?.toLowerCase() || undefined,
				collectorNumber: entry.card.collector_number || entry.card.collectorNumber || undefined,
				board,
				isCommander
			});
		}
	}

	return {
		name: data.name,
		format: data.format ?? null,
		commander: commanders.join(' / ') || null,
		moxfieldUrl: url,
		cards
	};
}
