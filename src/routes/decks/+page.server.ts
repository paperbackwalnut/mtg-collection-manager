import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/index';
import { decks, deckCards, cardAssignments } from '$lib/server/db/schema';
import { and, count, eq, isNull, isNotNull, inArray, sql } from 'drizzle-orm';

const MAIN_BOARDS = new Set(['main', 'commander']);

export const load: PageServerLoad = async () => {
	const deckList = await db
		.select()
		.from(decks)
		.where(isNull(decks.archivedAt))
		.orderBy(decks.updatedAt);

	// Card counts per deck per board (SUM quantity, not COUNT rows)
	const cardCounts = await db
		.select({
			deckId: deckCards.deckId,
			board: deckCards.board,
			total: sql<number>`CAST(SUM(${deckCards.quantity}) AS INTEGER)`
		})
		.from(deckCards)
		.groupBy(deckCards.deckId, deckCards.board);

	// Assignment stats — main/commander only, grouped by status + pulled
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

	// needsPrint: proxied + not pulled + has printStatus
	const needsPrintStats = await db
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

	// Maybeboard card count per deck (passive indicator)
	const maybeStats = await db
		.select({
			deckId: deckCards.deckId,
			total: sql<number>`CAST(SUM(${deckCards.quantity}) AS INTEGER)`
		})
		.from(deckCards)
		.where(eq(deckCards.board, 'maybe'))
		.groupBy(deckCards.deckId);

	// Card counts: main/commander vs side
	const mainCardCount = new Map<number, number>();
	const sideCardCount = new Map<number, number>();
	for (const r of cardCounts) {
		const isMain = MAIN_BOARDS.has(r.board ?? 'main');
		const target = isMain ? mainCardCount : sideCardCount;
		target.set(r.deckId, (target.get(r.deckId) ?? 0) + r.total);
	}

	// Build per-deck stats
	type DeckStats = {
		inDeck: number; // pulled=true (physically in deck)
		assigned: number; // status=assigned (real card, any pulled state)
		proxied: number; // status=proxied
		unassigned: number;
		needed: number;
		ordered: number;
		needsPrint: number; // proxied + pulled=false + printStatus set
		maybeCount: number; // maybeboard cards (passive indicator)
	};

	const mainStats = new Map<number, DeckStats>();
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

	for (const row of assignmentStats) {
		if (!mainStats.has(row.deckId)) mainStats.set(row.deckId, emptyStats());
		const s = mainStats.get(row.deckId)!;
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

	for (const row of needsPrintStats) {
		if (!mainStats.has(row.deckId)) mainStats.set(row.deckId, emptyStats());
		mainStats.get(row.deckId)!.needsPrint += row.cnt;
	}

	for (const row of maybeStats) {
		if (!mainStats.has(row.deckId)) mainStats.set(row.deckId, emptyStats());
		mainStats.get(row.deckId)!.maybeCount += row.total;
	}

	return {
		decks: deckList.map((d) => ({
			...d,
			mainCardCount: mainCardCount.get(d.id) ?? 0,
			sideCardCount: sideCardCount.get(d.id) ?? 0,
			mainStats: mainStats.get(d.id) ?? emptyStats()
		}))
	};
};
