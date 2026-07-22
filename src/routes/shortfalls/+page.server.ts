import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/index';
import { decks, deckCards } from '$lib/server/db/schema';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { getMinPriceByName } from '$lib/server/db/scryfall-sqlite';
import { BASIC_LAND_NAMES } from '$lib/basics';

export type ShortfallDeck = { id: number; name: string; deckQty: number };
export type ShortfallCard = {
	cardName: string;
	collQty: number;
	deckCount: number;
	totalDeckQty: number;
	shortfall: number;
	priceUsd: number | null;
	estimatedCost: number | null; // priceUsd × shortfall, null if no price
	decks: ShortfallDeck[];
};

export const load: PageServerLoad = async () => {
	// Step 1: aggregate deck usage + collection qty per card name.
	const rows = await db
		.select({
			cardName: deckCards.cardName,
			totalDeckQty: sql<number>`CAST(SUM(${deckCards.quantity}) AS INTEGER)`,
			deckCount: sql<number>`CAST(COUNT(DISTINCT ${deckCards.deckId}) AS INTEGER)`,
			collQty: sql<number>`CAST(COALESCE((
				SELECT SUM(c2.quantity)
				FROM collection c2
				WHERE c2.name = ${deckCards.cardName}
			), 0) AS INTEGER)`
		})
		.from(deckCards)
		.innerJoin(decks, eq(deckCards.deckId, decks.id))
		.where(and(ne(deckCards.board, 'maybe'), isNull(decks.archivedAt)))
		.groupBy(deckCards.cardName);

	const shortfallRows = rows
		.map((r) => ({ ...r, shortfall: r.totalDeckQty - r.collQty }))
		.filter((r) => r.shortfall > 0 && !BASIC_LAND_NAMES.has(r.cardName))
		.sort((a, b) => b.shortfall - a.shortfall || a.cardName.localeCompare(b.cardName));

	if (shortfallRows.length === 0) return { cards: [] as ShortfallCard[] };

	// Step 2: per-deck breakdown + Scryfall price lookup
	const cardNames = shortfallRows.map((r) => r.cardName);
	const [allDecks, deckBreakdown] = await Promise.all([
		db.select({ id: decks.id, name: decks.name }).from(decks).where(isNull(decks.archivedAt)),
		db
			.select({
				cardName: deckCards.cardName,
				deckId: deckCards.deckId,
				deckQty: deckCards.quantity
			})
			.from(deckCards)
			.innerJoin(decks, eq(deckCards.deckId, decks.id))
			.where(
				and(
					inArray(deckCards.cardName, cardNames),
					ne(deckCards.board, 'maybe'),
					isNull(decks.archivedAt)
				)
			)
	]);

	// Price lookups: MIN(price_usd) across all printings so we always find a price
	// even if getByName() happened to return a NULL-price printing.
	const priceByName = new Map<string, number | null>();
	for (const name of cardNames) {
		priceByName.set(name, getMinPriceByName(name));
	}

	const deckNameMap = new Map(allDecks.map((d) => [d.id, d.name]));

	const decksByCard = new Map<string, ShortfallDeck[]>();
	for (const row of deckBreakdown) {
		if (!decksByCard.has(row.cardName)) decksByCard.set(row.cardName, []);
		const list = decksByCard.get(row.cardName)!;
		const existing = list.find((d) => d.id === row.deckId);
		if (existing) {
			existing.deckQty += row.deckQty;
		} else {
			list.push({
				id: row.deckId,
				name: deckNameMap.get(row.deckId) ?? 'Unknown',
				deckQty: row.deckQty
			});
		}
	}

	const cards: ShortfallCard[] = shortfallRows.map((r) => {
		const price = priceByName.get(r.cardName) ?? null;
		return {
			cardName: r.cardName,
			collQty: r.collQty,
			deckCount: r.deckCount,
			totalDeckQty: r.totalDeckQty,
			shortfall: r.shortfall,
			priceUsd: price,
			estimatedCost: price != null ? Math.round(price * r.shortfall * 100) / 100 : null,
			decks: (decksByCard.get(r.cardName) ?? []).sort((a, b) => b.deckQty - a.deckQty)
		};
	});

	return { cards };
};
