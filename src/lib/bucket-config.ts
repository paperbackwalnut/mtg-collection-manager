/**
 * Card storage bucket configuration.
 *
 * Defines how cards are physically subdivided within each color box,
 * by type and CMC range.  The pick list uses this to generate sub-headers
 * and sort correctly: alpha within a single bucket, CMC-ordered across buckets.
 *
 * Cell values:
 *   "0-1,2,3,4,5,6+"  — specific CMC buckets (comma-separated)
 *   "all"              — one unsorted pile → sort alpha, no CMC sub-groups
 *   "n/a"              — nothing stored here
 *   "with creatures"   — Planeswalker-only: file with Creature buckets
 */

export type ColorKey = 'W' | 'U' | 'B' | 'R' | 'G' | 'C' | 'M';
export type BucketTypeKey =
	| 'Planeswalker'
	| 'Creature'
	| 'Instant'
	| 'Sorcery'
	| 'Enchantment'
	| 'Aura'
	| 'Enchantment+'
	| 'Artifact'
	| 'Equipment'
	| 'Vehicle';

export type BucketValue = 'all' | 'n/a' | 'with creatures' | string;

export type BucketConfig = Record<ColorKey, Record<BucketTypeKey, BucketValue>>;

// ── Display labels ────────────────────────────────────────────────────────────

export const COLOR_KEYS: ColorKey[] = ['W', 'U', 'B', 'R', 'G', 'C', 'M'];
export const BUCKET_TYPES: BucketTypeKey[] = [
	'Planeswalker',
	'Creature',
	'Instant',
	'Sorcery',
	'Enchantment',
	'Aura',
	'Enchantment+',
	'Artifact',
	'Equipment',
	'Vehicle'
];

export const COLOR_LABELS: Record<ColorKey, string> = {
	W: 'White',
	U: 'Blue',
	B: 'Black',
	R: 'Red',
	G: 'Green',
	C: 'Artifact/Colorless',
	M: 'Multicolor'
};

// ── Default config (from your physical storage setup) ────────────────────────

export const DEFAULT_BUCKET_CONFIG: BucketConfig = {
	W: {
		Planeswalker: 'n/a',
		Creature: '0-1,2,3,4,5+',
		Instant: '0-1,2,3,4,5,6+',
		Sorcery: '0-1,2,3,4,5,6+',
		Enchantment: '0-1,2,3,4,5+',
		Aura: '0-1,2,3,4,5+',
		'Enchantment+': '0-1,2,3,4,5+',
		Artifact: '0-1,2,3,4+',
		Equipment: '0-1,2,3+',
		Vehicle: '0-1,2,3,4,5,6+'
	},
	U: {
		Planeswalker: 'n/a',
		Creature: '0-1,2,3,4,5,6+',
		Instant: '0-1,2,3,4,5+',
		Sorcery: '0-1,2,3,4,5+',
		Enchantment: 'all',
		Aura: '0-1,2,3,4+',
		'Enchantment+': 'all',
		Artifact: 'all',
		Equipment: 'all',
		Vehicle: 'all'
	},
	B: {
		Planeswalker: 'all',
		Creature: '0-1,2,3,4,5,6+',
		Instant: '0-1,2,3,4,5+',
		Sorcery: '0-1,2,3,4,5,6+',
		Enchantment: '0-1,2,3,4,5,6+',
		Aura: 'all',
		'Enchantment+': '0-1,2,3,4,5+',
		Artifact: 'all',
		Equipment: 'all',
		Vehicle: 'all'
	},
	R: {
		Planeswalker: 'n/a',
		Creature: '0-1,2,3,4,5,6+',
		Instant: '0-1,2,3,4+',
		Sorcery: '0-1,2,3,4,5+',
		Enchantment: 'all',
		Aura: '0-1,2,3+',
		'Enchantment+': 'all',
		Artifact: 'all',
		Equipment: 'all',
		Vehicle: 'all'
	},
	G: {
		Planeswalker: 'n/a',
		Creature: '0-1,2,3,4,5,6+',
		Instant: '0-1,2,3,4+',
		Sorcery: '0-1,2,3,4+',
		Enchantment: '0-3,4+',
		Aura: '0-2,3+',
		'Enchantment+': 'all',
		Artifact: 'all',
		Equipment: 'all',
		Vehicle: 'all'
	},
	C: {
		Planeswalker: 'n/a',
		Creature: '0-1,2,3,4,5,6,7+',
		Instant: '0-2,3+',
		Sorcery: '0-2,3+',
		Enchantment: 'all',
		Aura: 'all',
		'Enchantment+': 'all',
		Artifact: 'all',
		Equipment: 'all',
		Vehicle: 'all'
	},
	M: {
		Planeswalker: 'with creatures',
		Creature: '0-2,3,4,5,6+',
		Instant: '0-2,3+',
		Sorcery: '0-2,3+',
		Enchantment: 'all',
		Aura: 'all',
		'Enchantment+': 'all',
		Artifact: 'all',
		Equipment: 'all',
		Vehicle: 'all'
	}
};

// ── Storage ───────────────────────────────────────────────────────────────────

const LS_KEY = 'bucketConfig';

export function getBucketConfig(): BucketConfig {
	if (typeof localStorage === 'undefined') return DEFAULT_BUCKET_CONFIG;
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return DEFAULT_BUCKET_CONFIG;
		// Merge over defaults so new type/color keys always exist
		const saved = JSON.parse(raw) as Partial<BucketConfig>;
		const merged = structuredClone(DEFAULT_BUCKET_CONFIG);
		for (const color of COLOR_KEYS) {
			if (saved[color]) {
				for (const type of BUCKET_TYPES) {
					if (saved[color]![type] !== undefined) {
						merged[color][type] = saved[color]![type]!;
					}
				}
			}
		}
		return merged;
	} catch {
		return DEFAULT_BUCKET_CONFIG;
	}
}

export function setBucketConfig(config: BucketConfig): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(LS_KEY, JSON.stringify(config));
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export type CmcBucket = { label: string; min: number; max: number };

/**
 * Parse "0-1,2,3,4,5,6+" into an ordered array of CMC buckets.
 * Each segment is one of:
 *   "N"    → exactly CMC N
 *   "M-N"  → CMC M through N (inclusive)
 *   "N+"   → CMC N and above (max = Infinity encoded as 9999)
 */
export function parseBucketRange(value: string): CmcBucket[] {
	if (value === 'all' || value === 'n/a' || value === 'with creatures') return [];
	return value.split(',').map((seg) => {
		seg = seg.trim();
		if (seg.endsWith('+')) {
			const min = parseInt(seg);
			return { label: `${min}+`, min, max: 9999 };
		}
		if (seg.includes('-')) {
			const [a, b] = seg.split('-').map(Number);
			return { label: `${a}–${b}`, min: a, max: b };
		}
		const n = parseInt(seg);
		return { label: String(n), min: n, max: n };
	});
}

// ── Card classification ───────────────────────────────────────────────────────

/** Derive the color key from a card's colors string ('W', 'WU', '', etc.). */
export function getColorKey(colors: string, typeLine: string): ColorKey | 'land' {
	if (typeLine.toLowerCase().includes('land')) return 'land';
	if (colors.length === 0) return 'C';
	if (colors.length === 1) return colors as ColorKey;
	return 'M';
}

/** Derive the bucket type key from a Scryfall type line. */
export function getTypeKey(typeLine: string): BucketTypeKey | null {
	const tl = typeLine.toLowerCase();
	if (tl.includes('land')) return null; // handled separately
	if (tl.includes('equipment')) return 'Equipment';
	if (tl.includes('vehicle')) return 'Vehicle';
	if (tl.includes('aura')) return 'Aura';
	if (tl.includes('creature')) return 'Creature';
	if (tl.includes('planeswalker')) return 'Planeswalker';
	if (tl.includes('enchantment')) {
		// Enchantment+ = non-standard subtypes (Saga, Class, Room, etc.)
		if (tl.includes('saga') || tl.includes('class') || tl.includes('room')) {
			return 'Enchantment+';
		}
		return 'Enchantment';
	}
	if (tl.includes('battle')) return 'Enchantment+'; // Battle — Siege etc.
	if (tl.includes('artifact')) return 'Artifact';
	if (tl.includes('instant')) return 'Instant';
	if (tl.includes('sorcery')) return 'Sorcery';
	return null;
}

/**
 * Given a card's colors + typeLine + cmc, return the bucket label it falls into.
 * Returns:
 *   string  — a specific label like "0–1" or "3+" or "all"
 *   "n/a"   — shouldn't be in pick list but include anyway
 *   null    — land (handled separately by caller)
 */
export function getItemBucketLabel(
	colors: string,
	typeLine: string,
	cmc: number,
	config: BucketConfig
): string | null {
	const colorKey = getColorKey(colors, typeLine);
	if (colorKey === 'land') return null;

	const typeKey = getTypeKey(typeLine);
	if (!typeKey) return 'all';

	let bucketValue: BucketValue = config[colorKey]?.[typeKey] ?? 'all';

	// "with creatures" — use the creature buckets for this color
	if (bucketValue === 'with creatures') {
		bucketValue = config[colorKey]?.['Creature'] ?? 'all';
	}

	if (bucketValue === 'all' || bucketValue === 'n/a') return bucketValue;

	const buckets = parseBucketRange(bucketValue);
	for (const b of buckets) {
		if (cmc >= b.min && cmc <= b.max) return b.label;
	}
	// Fallback: last bucket
	return buckets[buckets.length - 1]?.label ?? 'all';
}

/** Extract the land subtype from a type line ("Basic Land — Plains" → "Plains"). */
export function getLandSubtype(typeLine: string): string | null {
	const match = typeLine.match(/—\s*(\w+)/);
	return match ? match[1] : null;
}

/** Sort key that ignores a leading "The " so "The Gitrog Monster" sorts under G. */
export function sortKey(name: string): string {
	return name.replace(/^the\s+/i, '');
}
