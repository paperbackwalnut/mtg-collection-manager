import type { CardLocation } from '../types';
import { isLandOnlyTypeLine } from '../card-classification';

export function extractColorPipsFromManaCost(manaCost: string): Set<string> {
	if (!manaCost) return new Set();
	const colors = new Set<string>();

	// Single color symbols: {W}, {U}, {B}, {R}, {G}
	for (const m of manaCost.matchAll(/\{([WUBRG])\}/g)) {
		colors.add(m[1]);
	}
	// Hybrid {W/U}, {R/G} — both parts are colors
	for (const m of manaCost.matchAll(/\{([WUBRG])\/([WUBRG])\}/g)) {
		colors.add(m[1]);
		colors.add(m[2]);
	}
	// Phyrexian {W/P} — only the color part
	for (const m of manaCost.matchAll(/\{([WUBRG])\/P\}/g)) {
		colors.add(m[1]);
	}
	// Phyrexian hybrid {W/U/P}
	for (const m of manaCost.matchAll(/\{([WUBRG])\/([WUBRG])\/P\}/g)) {
		colors.add(m[1]);
		colors.add(m[2]);
	}

	return colors;
}

/** Prefer cached Scryfall color identity, falling back to mana-cost pips when unavailable. */
export function getCardColors(
	colorIdentity: string | null | undefined,
	manaCost: string | null | undefined
): Set<string> {
	if (colorIdentity != null) {
		try {
			const parsed: unknown = JSON.parse(colorIdentity);
			if (Array.isArray(parsed)) {
				return new Set(
					parsed.filter(
						(color): color is string =>
							typeof color === 'string' && ['W', 'U', 'B', 'R', 'G'].includes(color)
					)
				);
			}
		} catch {
			// An old or malformed cache value should not prevent mana-cost fallback.
		}
	}

	return extractColorPipsFromManaCost(manaCost ?? '');
}

const COLOR_TO_LOCATION: Record<string, CardLocation> = {
	W: 'box_w',
	U: 'box_u',
	B: 'box_b',
	R: 'box_r',
	G: 'box_g'
};

export function computeLocation(
	typeLine: string,
	manaCost: string | null | undefined,
	priceUsd: number | null | undefined,
	locationOverride: string | null | undefined,
	priceBinderThreshold = 10,
	colorIdentity?: string | null
): CardLocation {
	// Manual override takes absolute precedence
	if (locationOverride) return locationOverride as CardLocation;

	// Proxies are handled at assignment level; a collection-level Proxy Box override is unusual.

	// Price check — goes to binder if >= threshold
	if (priceUsd != null && priceUsd >= priceBinderThreshold) return 'binder';

	// Land check (before color pip check — lands have no mana cost)
	if (isLandOnlyTypeLine(typeLine)) return 'box_land';

	// Cached Scryfall color identity, with mana-cost pips as a legacy fallback
	const pips = getCardColors(colorIdentity, manaCost);
	if (pips.size === 0) return 'box_colorless';
	if (pips.size === 1) {
		const [c] = pips;
		return COLOR_TO_LOCATION[c] ?? 'box_colorless';
	}
	return 'box_multi';
}

// Type ordering within a box: Creature/PW=0, Instant=1, Sorcery=2,
// Enchantment=3, Aura=4, Enchantment+=5 (Rooms/Battles), Artifact=6, Equipment=7, Vehicle=8, Land=9
export function getTypeOrder(typeLine: string): number {
	const t = (typeLine ?? '').toLowerCase();

	// Check equipment/vehicle before artifact since they include 'artifact' in type line
	if (t.includes('equipment')) return 7;
	if (t.includes('vehicle')) return 8;

	// Creature and planeswalker share slot 0
	if (t.includes('creature') || t.includes('planeswalker')) return 0;
	if (t.includes('instant')) return 1;
	if (t.includes('sorcery')) return 2;

	// Aura before plain enchantment; Rooms/Battles after plain enchantment
	if (t.includes('aura')) return 4;
	if (t.includes('battle') || t.includes('room')) return 5;
	if (t.includes('enchantment')) return 3;

	// Artifact after equipment/vehicle guard above
	if (t.includes('artifact')) return 6;

	if (isLandOnlyTypeLine(typeLine)) return 9;

	return 10;
}
