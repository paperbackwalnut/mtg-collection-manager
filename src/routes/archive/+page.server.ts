import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/index';
import { decks, deckCards } from '$lib/server/db/schema';
import { isNotNull, sql } from 'drizzle-orm';

const MAIN_BOARDS = new Set(['main', 'commander']);

export const load: PageServerLoad = async () => {
	const archivedList = await db
		.select()
		.from(decks)
		.where(isNotNull(decks.archivedAt))
		.orderBy(decks.archivedAt);

	const deckIds = archivedList.map((d) => d.id);
	if (deckIds.length === 0) return { decks: [] };

	const cardCounts = await db
		.select({
			deckId: deckCards.deckId,
			board: deckCards.board,
			total: sql<number>`CAST(SUM(${deckCards.quantity}) AS INTEGER)`
		})
		.from(deckCards)
		.groupBy(deckCards.deckId, deckCards.board);

	const mainCardCount = new Map<number, number>();
	for (const r of cardCounts) {
		if (!deckIds.includes(r.deckId)) continue;
		if (MAIN_BOARDS.has(r.board ?? 'main')) {
			mainCardCount.set(r.deckId, (mainCardCount.get(r.deckId) ?? 0) + r.total);
		}
	}

	return {
		decks: archivedList.map((d) => ({
			...d,
			mainCardCount: mainCardCount.get(d.id) ?? 0
		}))
	};
};
