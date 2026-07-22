import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/index';
import { decks, deckCards } from '$lib/server/db/schema';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { getMinPriceByName } from '$lib/server/db/scryfall-sqlite';
import { BASIC_LAND_NAMES } from '$lib/basics';

export type DeckRef = { id: number; name: string; deckQty: number };
export type MissingCard = {
	cardName: string;
	deckCount: number;
	totalDeckQty: number;
	decks: DeckRef[];
	priceUsd: number | null;
	estimatedCost: number | null;
};

export const load: PageServerLoad = async () => {
	// Aggregate deck usage per card name, filtered to cards with zero collection qty
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

	const missingRows = rows.filter((r) => r.collQty === 0 && !BASIC_LAND_NAMES.has(r.cardName));
	if (missingRows.length === 0) return { cards: [] as MissingCard[] };

	const cardNames = missingRows.map((r) => r.cardName);

	// Per-deck breakdown
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

	const deckNameMap = new Map(allDecks.map((d) => [d.id, d.name]));

	// Build deck list per card
	const decksByCard = new Map<string, DeckRef[]>();
	for (const row of deckBreakdown) {
		if (!cardNames.includes(row.cardName)) continue;
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

	const cards: MissingCard[] = missingRows
		.map((r) => {
			const price = getMinPriceByName(r.cardName);
			return {
				cardName: r.cardName,
				deckCount: r.deckCount,
				totalDeckQty: r.totalDeckQty,
				decks: (decksByCard.get(r.cardName) ?? []).sort((a, b) => b.deckQty - a.deckQty),
				priceUsd: price,
				estimatedCost: price != null ? Math.round(price * r.totalDeckQty * 100) / 100 : null
			};
		})
		.sort((a, b) => b.totalDeckQty - a.totalDeckQty || a.cardName.localeCompare(b.cardName));

	return { cards };
};
