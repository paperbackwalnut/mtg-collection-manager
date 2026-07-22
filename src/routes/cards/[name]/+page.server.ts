import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db/index';
import { collection, cardAssignments, decks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { computeLocation } from '$lib/server/location';
import { getByIds } from '$lib/server/db/scryfall-sqlite';

export const load: PageServerLoad = async ({ params }) => {
	const cardName = decodeURIComponent(params.name);

	const rows = await db
		.select({
			id: collection.id,
			name: collection.name,
			setCode: collection.setCode,
			collectorNumber: collection.collectorNumber,
			condition: collection.condition,
			foil: collection.foil,
			quantity: collection.quantity,
			purchasePrice: collection.purchasePrice,
			locationOverride: collection.locationOverride,
			scryfallId: collection.scryfallId
		})
		.from(collection)
		.where(eq(collection.name, cardName));

	if (rows.length === 0) error(404, `No copies of "${cardName}" in collection`);

	// Enrich with Scryfall data from local SQLite
	const sc = getByIds(rows.map((r) => r.scryfallId));
	const entries = rows.map((r) => {
		const card = r.scryfallId ? sc.get(r.scryfallId) : undefined;
		return {
			...r,
			typeLine: card?.type_line ?? null,
			manaCost: card?.mana_cost ?? null,
			cmc: card?.cmc ?? null,
			priceUsd: card?.price_usd ?? null,
			priceUsdFoil: card?.price_usd_foil ?? null,
			imageUri: card?.image_uri ?? null,
			backImageUri: card?.back_image_uri ?? null
		};
	});

	// Get all assignments for this card
	const assignments = await db
		.select({
			id: cardAssignments.id,
			collectionId: cardAssignments.collectionId,
			deckId: cardAssignments.deckId,
			status: cardAssignments.status,
			proxySetCode: cardAssignments.proxySetCode,
			proxyCollectorNumber: cardAssignments.proxyCollectorNumber,
			deckName: decks.name,
			deckFormat: decks.format
		})
		.from(cardAssignments)
		.leftJoin(decks, eq(cardAssignments.deckId, decks.id))
		.where(eq(cardAssignments.cardName, cardName));

	// Group assignments by collectionId
	const assignmentsByCollectionId = new Map<number | null, typeof assignments>();
	for (const a of assignments) {
		const key = a.collectionId;
		if (!assignmentsByCollectionId.has(key)) assignmentsByCollectionId.set(key, []);
		assignmentsByCollectionId.get(key)!.push(a);
	}

	// Enrich entries with location and assignment info
	const enriched = entries.map((entry) => {
		const location = computeLocation(
			entry.typeLine ?? '',
			entry.manaCost,
			entry.priceUsd,
			entry.locationOverride
		);
		const entryAssignments = assignmentsByCollectionId.get(entry.id) ?? [];
		const activeAssignments = entryAssignments.filter((a) => a.status === 'assigned');
		return {
			...entry,
			location,
			assignments: entryAssignments,
			activeCount: activeAssignments.length,
			available: entry.quantity - activeAssignments.length
		};
	});

	const unlinkedAssignments = assignmentsByCollectionId.get(null) ?? [];

	return { cardName, entries: enriched, unlinkedAssignments };
};
