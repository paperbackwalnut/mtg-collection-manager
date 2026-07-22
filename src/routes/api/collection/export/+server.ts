import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/index';
import { collection, cardAssignments } from '$lib/server/db/schema';
import { and, count, inArray, sql } from 'drizzle-orm';
import { computeLocation } from '$lib/server/location';
import { getByIds } from '$lib/server/db/scryfall-sqlite';
import {
	parseScryfallSearch,
	executeSearch,
	CacheNotReadyError
} from '$lib/server/scryfall-search';
import { buildNameConditions, applySortToEntries } from '$lib/server/collection-filters';
import { resolveSharedOracleTagIndex } from '$lib/server/shared-oracle-tag-search';
import { LOCATION_LABELS } from '$lib/types';
import type { CardLocation } from '$lib/types';
import { getCollectionSearchCandidates } from '$lib/server/collection-search-candidates';

function csvCell(val: string | number | null | undefined): string {
	if (val === null || val === undefined) return '';
	const s = String(val);
	if (s.includes(',') || s.includes('"') || s.includes('\n')) {
		return '"' + s.replace(/"/g, '""') + '"';
	}
	return s;
}

export const GET: RequestHandler = async ({ url }) => {
	const search = url.searchParams.get('q') ?? '';
	const locationFilter = url.searchParams.get('loc') ?? '';
	const tagFilter = url.searchParams.get('tag') ?? '';

	const ast = parseScryfallSearch(search);

	// Validation errors → HTTP 400, no DB query
	if (ast.errors.length > 0) {
		return new Response(JSON.stringify({ errors: ast.errors.map((e) => e.message) }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Candidate-bounded Scryfall filter
	let scryfallIds: string[] | null = null;
	if (ast.requiresExecutor) {
		try {
			const candidateRows = await getCollectionSearchCandidates();
			const sharedOracleTags = await resolveSharedOracleTagIndex(ast);
			scryfallIds = executeSearch(
				ast,
				candidateRows.map((row) => row.scryfallId),
				undefined,
				sharedOracleTags
			);
		} catch (e) {
			if (e instanceof CacheNotReadyError) {
				return new Response(JSON.stringify({ errors: [e.message] }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			throw e;
		}
	}

	// Build WHERE clause (same logic as collection page)
	const conditions: any[] = [
		...(ast.useDatabaseNameTerms ? buildNameConditions(ast.nameTerms, collection.name) : [])
	];
	if (tagFilter)
		conditions.push(
			sql`EXISTS (SELECT 1 FROM json_each(${collection.tags}) WHERE value = ${tagFilter})`
		);
	if (scryfallIds !== null) {
		conditions.push(
			scryfallIds.length === 0 ? sql`false` : inArray(collection.scryfallId, scryfallIds)
		);
	}

	const whereClause =
		conditions.length === 0
			? undefined
			: conditions.length === 1
				? conditions[0]
				: and(...conditions);

	// Assigned counts
	const assignmentCounts = await db
		.select({ collectionId: cardAssignments.collectionId, cnt: count() })
		.from(cardAssignments)
		.where(
			sql`${cardAssignments.status} = 'assigned' AND ${cardAssignments.collectionId} IS NOT NULL`
		)
		.groupBy(cardAssignments.collectionId);
	const assignedMap = new Map<number, number>();
	for (const row of assignmentCounts) {
		if (row.collectionId !== null) assignedMap.set(row.collectionId, row.cnt);
	}

	const rows = await db
		.select({
			id: collection.id,
			name: collection.name,
			setCode: collection.setCode,
			collectorNumber: collection.collectorNumber,
			condition: collection.condition,
			foil: collection.foil,
			quantity: collection.quantity,
			locationOverride: collection.locationOverride,
			tags: collection.tags,
			scryfallId: collection.scryfallId
		})
		.from(collection)
		.where(whereClause)
		.orderBy(collection.name);

	const scMap = getByIds(rows.map((r) => r.scryfallId));

	let enriched = rows.map((r) => {
		const card = r.scryfallId ? scMap.get(r.scryfallId) : undefined;
		const typeLine = card?.type_line ?? null;
		const manaCost = card?.mana_cost ?? null;
		const priceUsd = card?.price_usd ?? null;
		const priceUsdFoil = card?.price_usd_foil ?? null;
		const edhrecRank = card?.edhrec_rank ?? null;
		const cmc = card?.cmc ?? null;
		const location = computeLocation(typeLine ?? '', manaCost, priceUsd, r.locationOverride);
		const assigned = assignedMap.get(r.id) ?? 0;
		const available = r.quantity - assigned;
		const locationLabel = LOCATION_LABELS[location as CardLocation] ?? location;
		let tags = '';
		try {
			tags = r.tags ? JSON.parse(r.tags).join('; ') : '';
		} catch {
			/* ignore */
		}
		return {
			...r,
			location,
			locationLabel,
			assigned,
			available,
			typeLine,
			manaCost,
			edhrecRank,
			cmc,
			priceUsd,
			priceUsdFoil,
			tags
		};
	});

	if (locationFilter) enriched = enriched.filter((e) => e.location === locationFilter);

	// Use shared sort helper — identical logic to collection page
	const sorted = applySortToEntries(enriched, ast);

	const HEADERS = [
		'Name',
		'Set',
		'Collector #',
		'Foil',
		'Condition',
		'Qty',
		'Assigned',
		'Available',
		'Price USD',
		'Location',
		'Type',
		'Tags'
	];
	const lines: string[] = [HEADERS.join(',')];

	for (const e of sorted) {
		// Foil-aware price for CSV column
		const price = (e.foil ? e.priceUsdFoil : null) ?? e.priceUsd;
		lines.push(
			[
				csvCell(e.name),
				csvCell(e.setCode.toUpperCase()),
				csvCell(e.collectorNumber),
				csvCell(e.foil ? 'Yes' : 'No'),
				csvCell(e.condition),
				csvCell(e.quantity),
				csvCell(e.assigned),
				csvCell(e.available),
				csvCell(price != null ? price.toFixed(2) : ''),
				csvCell(e.locationLabel),
				csvCell(e.typeLine ?? ''),
				csvCell(e.tags)
			].join(',')
		);
	}

	const csv = lines.join('\r\n');
	const filename = `collection-export${search ? '-' + search.replace(/[^a-z0-9]+/gi, '-') : ''}.csv`;

	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${filename}"`
		}
	});
};
