import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/index';
import { decks, deckCards, cardAssignments, collection } from '$lib/server/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { computeLocation, getTypeOrder } from '$lib/server/location';
import { LOCATION_ORDER } from '$lib/types';
import type { CardLocation, PickListItem } from '$lib/types';
import { getByIds, getByName as scryfallByName } from '$lib/server/db/scryfall-sqlite';

export const load: PageServerLoad = async ({ url }) => {
	const deckParam = url.searchParams.get('deck');
	const hideStatuses = url.searchParams.get('hide')?.split(',') ?? [];
	const showBoard = url.searchParams.get('board') ?? 'main';

	const allDecks = await db
		.select({ id: decks.id, name: decks.name })
		.from(decks)
		.where(isNull(decks.archivedAt))
		.orderBy(decks.name);

	let selectedDeckIds: number[];
	if (!deckParam || deckParam === 'all') {
		selectedDeckIds = allDecks.map((d) => d.id);
	} else if (deckParam === 'none') {
		selectedDeckIds = [];
	} else {
		selectedDeckIds = deckParam
			.split(',')
			.map(Number)
			.filter((n) => !isNaN(n) && n > 0);
	}

	if (selectedDeckIds.length === 0) {
		return { allDecks, selectedDeckIds, items: [], groupedItems: [], hideStatuses, showBoard };
	}

	// Fetch assignments with collection data (no scryfallCache join — use SQLite below)
	const rows = await db
		.select({
			assignmentId: cardAssignments.id,
			deckId: cardAssignments.deckId,
			cardName: cardAssignments.cardName,
			status: cardAssignments.status,
			pulled: cardAssignments.pulled,
			printStatus: cardAssignments.printStatus,
			collectionId: cardAssignments.collectionId,
			proxySetCode: cardAssignments.proxySetCode,
			proxyCollectorNumber: cardAssignments.proxyCollectorNumber,
			// Collection
			collSetCode: collection.setCode,
			collCollectorNumber: collection.collectorNumber,
			collFoil: collection.foil,
			collLocationOverride: collection.locationOverride,
			collScryfallId: collection.scryfallId,
			// Deck card info
			dcBoard: deckCards.board,
			dcIsCommander: deckCards.isCommander
		})
		.from(cardAssignments)
		.leftJoin(collection, eq(cardAssignments.collectionId, collection.id))
		.leftJoin(deckCards, eq(cardAssignments.deckCardId, deckCards.id))
		.where(
			and(
				selectedDeckIds.length === 1
					? eq(cardAssignments.deckId, selectedDeckIds[0])
					: inArray(cardAssignments.deckId, selectedDeckIds),
				inArray(cardAssignments.status, ['assigned', 'proxied']),
				sql`${deckCards.board} != 'maybe'`
			)
		);

	// Batch-lookup all collection-linked scryfall data from SQLite
	const sc = getByIds(rows.map((r) => r.collScryfallId));

	const deckNameMap = new Map(allDecks.map((d) => [d.id, d.name]));

	// Name-based lookups for ALL unique card names.
	// Used as primary source for type_line (same across all printings of a card),
	// so mismatches in the collection-linked Scryfall row don't misclassify cards.
	const nameLookups = new Map<string, ReturnType<typeof scryfallByName>>();
	for (const row of rows) {
		if (!nameLookups.has(row.cardName)) {
			nameLookups.set(row.cardName, scryfallByName(row.cardName));
		}
	}

	function extractColors(manaCost: string | null | undefined): string {
		if (!manaCost) return '';
		return ['W', 'U', 'B', 'R', 'G'].filter((c) => manaCost.includes(`{${c}}`)).join('');
	}

	const items: PickListItem[] = [];

	for (const row of rows) {
		if (hideStatuses.includes(row.status)) continue;

		// Get scryfall data: prefer collection-linked row for image/price/mana data,
		// but always use name-based type_line since it's identical across all printings
		// and the collection-linked row may have an incomplete type_line in the cache.
		const cardSc = row.collScryfallId
			? sc.get(row.collScryfallId)
			: (nameLookups.get(row.cardName) ?? undefined);
		const nameSc = nameLookups.get(row.cardName);
		const typeLine = nameSc?.type_line || cardSc?.type_line || '';

		let location: CardLocation = 'unknown';
		if (row.status === 'proxied') {
			location = 'proxy_box';
		} else if (cardSc) {
			location = computeLocation(
				typeLine,
				cardSc.mana_cost,
				cardSc.price_usd,
				row.collLocationOverride
			);
		}

		items.push({
			assignmentId: row.assignmentId,
			cardName: row.cardName,
			setCode: row.collSetCode ?? row.proxySetCode ?? null,
			collectorNumber: row.collCollectorNumber ?? row.proxyCollectorNumber ?? null,
			foil: row.collFoil ?? false,
			status: row.status as any,
			location,
			typeOrder: getTypeOrder(typeLine),
			cmc: cardSc?.cmc ?? nameSc?.cmc ?? 0,
			typeLine,
			colors: extractColors(cardSc?.mana_cost ?? nameSc?.mana_cost),
			imageUri: cardSc?.image_uri ?? null,
			priceUsd: cardSc?.price_usd ?? null,
			deckId: row.deckId,
			deckName: deckNameMap.get(row.deckId) ?? 'Unknown',
			board: row.dcBoard ?? 'main',
			isCommander: row.dcIsCommander ?? false,
			hasCollection: row.collectionId !== null,
			collectionId: row.collectionId ?? null,
			pulled: row.pulled ?? false,
			printStatus: row.printStatus ?? null
		});
	}

	// Group by location, sort within group: type → cmc → name
	const grouped = new Map<CardLocation, PickListItem[]>();
	for (const item of items) {
		if (!grouped.has(item.location)) grouped.set(item.location, []);
		grouped.get(item.location)!.push(item);
	}

	for (const [, group] of grouped) {
		group.sort((a, b) => {
			if (a.typeOrder !== b.typeOrder) return a.typeOrder - b.typeOrder;
			if (a.cmc !== b.cmc) return a.cmc - b.cmc;
			return a.cardName.localeCompare(b.cardName);
		});
	}

	const groupedItems = LOCATION_ORDER.filter((loc) => grouped.has(loc)).map((loc) => ({
		location: loc,
		items: grouped.get(loc)!
	}));

	return { allDecks, selectedDeckIds, groupedItems, hideStatuses, showBoard };
};
