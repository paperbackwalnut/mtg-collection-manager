import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/index';
import { collection, decks, deckCards, cardAssignments } from '$lib/server/db/schema';
import { and, count, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { BASIC_LAND_NAMES } from '$lib/basics';
import { getAccessInfo } from '$lib/server/access-info';

export const load: PageServerLoad = async () => {
	const access = await getAccessInfo();
	// ── Global stats ──────────────────────────────────────────────────────
	const [collectionCount] = await db
		.select({
			count: sql<number>`CAST(COALESCE(SUM(${collection.quantity}), 0) AS INTEGER)`
		})
		.from(collection);
	const [deckCount] = await db
		.select({ count: count() })
		.from(decks)
		.where(isNull(decks.archivedAt));

	// ── All active decks ──────────────────────────────────────────────────
	const allDecks = await db
		.select({
			id: decks.id,
			name: decks.name,
			format: decks.format,
			commander: decks.commander,
			updatedAt: decks.updatedAt
		})
		.from(decks)
		.where(isNull(decks.archivedAt))
		.orderBy(decks.updatedAt);

	// ── Main/commander card counts per deck ───────────────────────────────
	const cardCountRows = await db
		.select({
			deckId: deckCards.deckId,
			total: sql<number>`CAST(SUM(${deckCards.quantity}) AS INTEGER)`
		})
		.from(deckCards)
		.where(inArray(deckCards.board, ['main', 'commander']))
		.groupBy(deckCards.deckId);

	const mainCardCount = new Map(cardCountRows.map((r) => [r.deckId, r.total]));

	// ── Per-deck assignment stats — main/commander only ───────────────────
	const assignmentStats = await db
		.select({
			deckId: cardAssignments.deckId,
			status: cardAssignments.status,
			pulled: cardAssignments.pulled,
			cnt: count()
		})
		.from(cardAssignments)
		.innerJoin(deckCards, eq(cardAssignments.deckCardId, deckCards.id))
		.where(inArray(deckCards.board, ['main', 'commander']))
		.groupBy(cardAssignments.deckId, cardAssignments.status, cardAssignments.pulled);

	// needsPrint per deck
	const needsPrintRows = await db
		.select({ deckId: cardAssignments.deckId, cnt: count() })
		.from(cardAssignments)
		.innerJoin(deckCards, eq(cardAssignments.deckCardId, deckCards.id))
		.where(
			and(
				inArray(deckCards.board, ['main', 'commander']),
				eq(cardAssignments.status, 'proxied'),
				eq(cardAssignments.pulled, false),
				isNotNull(cardAssignments.printStatus)
			)
		)
		.groupBy(cardAssignments.deckId);

	// maybeboard card count per deck (passive indicator)
	const maybeRows = await db
		.select({
			deckId: deckCards.deckId,
			total: sql<number>`CAST(SUM(${deckCards.quantity}) AS INTEGER)`
		})
		.from(deckCards)
		.where(eq(deckCards.board, 'maybe'))
		.groupBy(deckCards.deckId);

	type DeckStats = {
		inDeck: number;
		assigned: number;
		proxied: number;
		unassigned: number;
		needed: number;
		ordered: number;
		needsPrint: number;
		maybeCount: number;
	};
	const emptyStats = (): DeckStats => ({
		inDeck: 0,
		assigned: 0,
		proxied: 0,
		unassigned: 0,
		needed: 0,
		ordered: 0,
		needsPrint: 0,
		maybeCount: 0
	});

	const statsByDeck = new Map<number, DeckStats>();

	for (const row of assignmentStats) {
		if (!statsByDeck.has(row.deckId)) statsByDeck.set(row.deckId, emptyStats());
		const s = statsByDeck.get(row.deckId)!;
		if (row.pulled) s.inDeck += row.cnt;
		switch (row.status) {
			case 'assigned':
				s.assigned += row.cnt;
				break;
			case 'proxied':
				s.proxied += row.cnt;
				break;
			case 'unassigned':
				s.unassigned += row.cnt;
				break;
			case 'needed':
				s.needed += row.cnt;
				break;
			case 'ordered':
				s.ordered += row.cnt;
				break;
		}
	}
	for (const r of needsPrintRows) {
		if (!statsByDeck.has(r.deckId)) statsByDeck.set(r.deckId, emptyStats());
		statsByDeck.get(r.deckId)!.needsPrint += r.cnt;
	}
	for (const r of maybeRows) {
		if (!statsByDeck.has(r.deckId)) statsByDeck.set(r.deckId, emptyStats());
		statsByDeck.get(r.deckId)!.maybeCount += r.total;
	}

	const packedUnfulfilledRows = await db
		.select({
			assignmentId: cardAssignments.id,
			deckId: cardAssignments.deckId,
			deckName: decks.name,
			cardName: cardAssignments.cardName,
			status: cardAssignments.status,
			board: deckCards.board
		})
		.from(cardAssignments)
		.innerJoin(deckCards, eq(cardAssignments.deckCardId, deckCards.id))
		.innerJoin(decks, eq(cardAssignments.deckId, decks.id))
		.where(
			and(
				isNull(decks.archivedAt),
				eq(cardAssignments.pulled, true),
				sql`${deckCards.board} != 'maybe'`,
				notInArray(cardAssignments.cardName, [...BASIC_LAND_NAMES]),
				sql`NOT (
					${cardAssignments.status} = 'proxied'
					OR (${cardAssignments.status} = 'assigned' AND ${cardAssignments.collectionId} IS NOT NULL)
				)`
			)
		)
		.orderBy(decks.name, cardAssignments.cardName)
		.limit(12);

	// ── Global summary counts ─────────────────────────────────────────────
	let totalInDeck = 0,
		totalReal = 0,
		totalProxy = 0,
		totalNeeded = 0;
	for (const s of statsByDeck.values()) {
		totalInDeck += s.inDeck;
		totalReal += s.assigned;
		totalProxy += s.proxied;
		totalNeeded += s.needed + s.unassigned;
	}

	return {
		access,
		stats: {
			collectionEntries: collectionCount.count,
			deckCount: deckCount.count,
			totalInDeck,
			totalReal,
			totalProxy,
			totalNeeded
		},
		packedUnfulfilled: packedUnfulfilledRows,
		decks: allDecks.map((d) => ({
			...d,
			mainCardCount: mainCardCount.get(d.id) ?? 0,
			deckStats: statsByDeck.get(d.id) ?? emptyStats()
		}))
	};
};
