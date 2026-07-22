/**
 * Shared helpers for Collection page and CSV export.
 * Both routes MUST use these functions so filtering and sorting cannot drift.
 */

import { ilike, not } from 'drizzle-orm';
import type { SearchAST } from './scryfall-search';

/**
 * Build Drizzle WHERE conditions for nameTerms.
 * Each term is applied independently (AND semantics):
 *   positive → col ILIKE '%term%'
 *   negative → col NOT ILIKE '%term%'
 * Multi-word bare-text like "Ring Sol" produces two terms that each match
 * independently, so "Sol Ring" satisfies both.
 */
export function buildNameConditions(nameTerms: SearchAST['nameTerms'], col: any): any[] {
	return nameTerms
		.filter((t) => t.value.trim())
		.map((t) => (t.negate ? not(ilike(col, `%${t.value}%`)) : ilike(col, `%${t.value}%`)));
}

type SortableEntry = {
	name: string;
	setCode: string;
	collectorNumber: string;
	foil: boolean | null;
	cmc: number | null;
	priceUsd: number | null;
	priceUsdFoil: number | null;
	edhrecRank: number | null;
};

/**
 * Sort an array of enriched collection entries per the AST's sort + direction.
 * Nulls are always last regardless of direction.
 * Price sort uses foil price for foil entries with regular-price fallback.
 * Returns a new array; does not mutate the input.
 */
export function applySortToEntries<T extends SortableEntry>(entries: T[], ast: SearchAST): T[] {
	const dir = ast.direction === 'desc' ? -1 : 1;
	const copy: T[] = [...entries];
	copy.sort((a, b) => {
		switch (ast.sort) {
			case 'mv': {
				const ac = a.cmc,
					bc = b.cmc;
				if (ac === null && bc === null) return 0;
				if (ac === null) return 1;
				if (bc === null) return -1;
				return dir * (ac - bc);
			}

			case 'price': {
				const ap = (a.foil === true ? a.priceUsdFoil : null) ?? a.priceUsd;
				const bp = (b.foil === true ? b.priceUsdFoil : null) ?? b.priceUsd;
				if (ap === null && bp === null) return 0;
				if (ap === null) return 1;
				if (bp === null) return -1;
				return dir * (ap - bp);
			}

			case 'edhrec': {
				const ae = a.edhrecRank,
					be = b.edhrecRank;
				if (ae === null && be === null) return 0;
				if (ae === null) return 1;
				if (be === null) return -1;
				return dir * (ae - be);
			}

			case 'set': {
				const sc = dir * a.setCode.localeCompare(b.setCode);
				return sc !== 0
					? sc
					: dir * a.collectorNumber.localeCompare(b.collectorNumber, undefined, { numeric: true });
			}

			default: // name
				return dir * a.name.localeCompare(b.name);
		}
	});
	return copy;
}
