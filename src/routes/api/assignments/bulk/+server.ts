import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/index';
import { cardAssignments, collection, deckCards } from '$lib/server/db/schema';
import { inArray, eq, and, or, sql, count, isNotNull } from 'drizzle-orm';

export const POST: RequestHandler = async ({ request }) => {
	const body: { ids: number[]; action: string; setCode?: string } = await request.json();
	const { ids, action } = body;
	if (!ids?.length) return json({ updated: 0 });

	switch (action) {
		case 'pull':
			await db
				.update(cardAssignments)
				.set({ pulled: true })
				.where(
					and(
						inArray(cardAssignments.id, ids),
						or(
							eq(cardAssignments.status, 'proxied'),
							and(eq(cardAssignments.status, 'assigned'), isNotNull(cardAssignments.collectionId))
						)
					)
				);
			break;

		case 'unpull':
			await db
				.update(cardAssignments)
				.set({ pulled: false })
				.where(inArray(cardAssignments.id, ids));
			break;

		case 'unassign':
			await db
				.update(cardAssignments)
				.set({ status: 'unassigned', collectionId: null, pulled: false, printStatus: null })
				.where(inArray(cardAssignments.id, ids));
			break;

		case 'proxied':
			await db
				.update(cardAssignments)
				.set({
					status: 'proxied',
					collectionId: null,
					pulled: false,
					printStatus: sql`CASE
						WHEN ${cardAssignments.status} = 'proxied' THEN ${cardAssignments.printStatus}
						ELSE 'need_print'
					END`
				})
				.where(inArray(cardAssignments.id, ids));
			break;

		case 'proxiedNeedsPrint':
			await db
				.update(cardAssignments)
				.set({ status: 'proxied', collectionId: null, pulled: false, printStatus: 'need_print' })
				.where(inArray(cardAssignments.id, ids));
			break;

		case 'needed':
			await db
				.update(cardAssignments)
				.set({ status: 'needed', collectionId: null, pulled: false, printStatus: null })
				.where(inArray(cardAssignments.id, ids));
			break;

		case 'order':
			await db
				.update(cardAssignments)
				.set({ status: 'ordered', collectionId: null, pulled: false, printStatus: null })
				.where(inArray(cardAssignments.id, ids));
			break;

		case 'autoAssign': {
			// For each assignment, find the deck_card's set+collector and try to
			// match an available collection entry with an exact set+collector match.
			const rows = await db
				.select({
					assignmentId: cardAssignments.id,
					cardName: cardAssignments.cardName,
					deckCardId: cardAssignments.deckCardId
				})
				.from(cardAssignments)
				.where(inArray(cardAssignments.id, ids));

			// Get the deck card info for set+collector
			const dcIds = [...new Set(rows.map((r) => r.deckCardId))];
			const dcRows = await db
				.select({
					id: deckCards.id,
					setCode: deckCards.setCode,
					collectorNumber: deckCards.collectorNumber
				})
				.from(deckCards)
				.where(inArray(deckCards.id, dcIds));
			const dcMap = new Map(dcRows.map((d) => [d.id, d]));

			for (const row of rows) {
				const dc = dcMap.get(row.deckCardId);
				if (!dc?.setCode || !dc?.collectorNumber) continue; // no set info, skip

				const available = await db
					.select({ id: collection.id, quantity: collection.quantity })
					.from(collection)
					.where(
						and(
							eq(collection.name, row.cardName),
							eq(collection.setCode, dc.setCode),
							eq(collection.collectorNumber, dc.collectorNumber)
						)
					)
					.limit(10);

				for (const entry of available) {
					const [{ cnt }] = await db
						.select({ cnt: count() })
						.from(cardAssignments)
						.where(
							and(
								eq(cardAssignments.collectionId, entry.id),
								eq(cardAssignments.status, 'assigned')
							)
						);
					if (entry.quantity - cnt > 0) {
						await db
							.update(cardAssignments)
							.set({
								collectionId: entry.id,
								status: 'assigned',
								pulled: false,
								printStatus: null
							})
							.where(eq(cardAssignments.id, row.assignmentId));
						break;
					}
				}
			}
			break;
		}

		case 'linkFromSet': {
			// Link each assignment to the first available collection entry matching
			// the card name + user-supplied set code. Used for bulk-assigning precon printings.
			const setCode = (body.setCode ?? '').trim().toLowerCase();
			if (!setCode) return json({ error: 'setCode required' }, { status: 400 });

			const rows = await db
				.select({ assignmentId: cardAssignments.id, cardName: cardAssignments.cardName })
				.from(cardAssignments)
				.where(inArray(cardAssignments.id, ids));

			let linked = 0;
			let notFound = 0;
			let unavailable = 0;

			for (const row of rows) {
				// Find all collection entries for this card + set
				const entries = await db
					.select({ id: collection.id, quantity: collection.quantity })
					.from(collection)
					.where(and(eq(collection.name, row.cardName), eq(collection.setCode, setCode)))
					.limit(10);

				if (entries.length === 0) {
					notFound++;
					continue;
				}

				let didLink = false;
				for (const entry of entries) {
					// Count assignments already using this copy
					const [{ cnt }] = await db
						.select({ cnt: count() })
						.from(cardAssignments)
						.where(
							and(
								eq(cardAssignments.collectionId, entry.id),
								eq(cardAssignments.status, 'assigned')
							)
						);
					if (entry.quantity - cnt > 0) {
						await db
							.update(cardAssignments)
							.set({
								collectionId: entry.id,
								status: 'assigned',
								pulled: false,
								printStatus: null
							})
							.where(eq(cardAssignments.id, row.assignmentId));
						linked++;
						didLink = true;
						break;
					}
				}
				if (!didLink) unavailable++;
			}

			return json({ linked, notFound, unavailable });
		}

		default:
			return json({ error: 'Unknown action' }, { status: 400 });
	}

	return json({ updated: ids.length });
};
