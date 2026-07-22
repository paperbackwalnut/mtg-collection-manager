import type { PageServerLoad, Actions } from './$types';
import { db } from '$lib/server/db/index';
import { collection, cardAssignments } from '$lib/server/db/schema';
import { eq, and, count, sql, inArray, asc, desc } from 'drizzle-orm';
import { computeLocation } from '$lib/server/location';
import { isWritableCardLocation } from '$lib/types';
import { refreshPricesFromBulkData } from '$lib/server/scryfall';
import { fail } from '@sveltejs/kit';
import { getByIds, getStats as scryfallStats, getBySetColl } from '$lib/server/db/scryfall-sqlite';
import {
	parseScryfallSearch,
	executeSearch,
	CacheNotReadyError
} from '$lib/server/scryfall-search';
import { buildNameConditions, applySortToEntries } from '$lib/server/collection-filters';
import { resolveSharedOracleTagIndex } from '$lib/server/shared-oracle-tag-search';
import {
	getCollectionSearchCandidates,
	invalidateCollectionSearchCandidates
} from '$lib/server/collection-search-candidates';

const PAGE_SIZE = 75;

export const load: PageServerLoad = async ({ url }) => {
	const search = url.searchParams.get('q') ?? '';
	const locationFilter = url.searchParams.get('loc') ?? '';
	const tagFilter = url.searchParams.get('tag') ?? '';
	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1') || 1);

	// Price staleness — cheapest to compute, always return it
	const oldestPriceTs = scryfallStats().lastUpdated ?? null;

	const ast = parseScryfallSearch(search);

	// ── Early return on parse errors ──────────────────────────────────────────
	if (ast.errors.length > 0) {
		return {
			entries: [],
			search,
			locationFilter,
			tagFilter,
			page,
			pageSize: PAGE_SIZE,
			total: 0,
			oldestPriceTs,
			sort: ast.sort,
			searchError: ast.errors.map((e) => e.message).join('; ')
		};
	}

	// ── Candidate-bounded Scryfall filter ─────────────────────────────────────
	let scryfallIds: string[] | null = null;
	let searchError: string | null = null;

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
				searchError = e.message;
			} else {
				throw e;
			}
		}
	}

	if (searchError) {
		return {
			entries: [],
			search,
			locationFilter,
			tagFilter,
			page,
			pageSize: PAGE_SIZE,
			total: 0,
			oldestPriceTs,
			sort: ast.sort,
			searchError
		};
	}

	// ── Build WHERE clause ────────────────────────────────────────────────────
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

	async function getAssignedMap(collectionIds: number[]): Promise<Map<number, number>> {
		const assignedMap = new Map<number, number>();
		if (collectionIds.length === 0) return assignedMap;
		const assignmentCounts = await db
			.select({ collectionId: cardAssignments.collectionId, cnt: count() })
			.from(cardAssignments)
			.where(
				and(
					eq(cardAssignments.status, 'assigned'),
					inArray(cardAssignments.collectionId, collectionIds)
				)
			)
			.groupBy(cardAssignments.collectionId);
		for (const row of assignmentCounts) {
			if (row.collectionId !== null) assignedMap.set(row.collectionId, row.cnt);
		}
		return assignedMap;
	}

	function enrichWithScryfall<T extends { scryfallId: string | null }>(rows: T[]) {
		const scMap = getByIds(rows.map((r) => r.scryfallId));
		return rows.map((r) => {
			const card = r.scryfallId ? scMap.get(r.scryfallId) : undefined;
			return {
				...r,
				typeLine: card?.type_line ?? null,
				manaCost: card?.mana_cost ?? null,
				cmc: card?.cmc ?? null,
				edhrecRank: card?.edhrec_rank ?? null,
				priceUsd: card?.price_usd ?? null,
				priceUsdFoil: card?.price_usd_foil ?? null,
				imageUri: card?.image_uri ?? null,
				backImageUri: card?.back_image_uri ?? null,
				lastUpdated: card?.last_updated ?? null
			};
		});
	}

	const SELECT_COLS = {
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
	};

	let total: number;
	let entries: any[];

	// Only Scryfall-backed fields and computed locations require loading the full
	// result set. Name and set sorting stay paginated in the collection database.
	const needsInProcessSort =
		ast.sort === 'mv' || ast.sort === 'price' || ast.sort === 'edhrec' || !!locationFilter;

	if (needsInProcessSort) {
		const rows = await db
			.select(SELECT_COLS)
			.from(collection)
			.where(whereClause)
			.orderBy(collection.name);
		const assignedMap = await getAssignedMap(rows.map((row) => row.id));

		const enriched = enrichWithScryfall(rows);

		let mapped = enriched.map((r) => {
			const location = computeLocation(
				r.typeLine ?? '',
				r.manaCost,
				r.priceUsd,
				r.locationOverride
			);
			const assigned = assignedMap.get(r.id) ?? 0;
			return { ...r, location, available: r.quantity - assigned, assigned };
		});

		if (locationFilter) mapped = mapped.filter((e) => e.location === locationFilter);

		mapped = applySortToEntries(mapped, ast);

		total = mapped.length;
		entries = mapped.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
	} else {
		const direction = ast.direction === 'desc' ? desc : asc;
		const orderBy =
			ast.sort === 'set'
				? [direction(collection.setCode), direction(collection.collectorNumber)]
				: [direction(collection.name)];

		// Collection-database pagination for name and set sorting.
		const [[countRow], rows] = await Promise.all([
			db.select({ cnt: count() }).from(collection).where(whereClause),
			db
				.select(SELECT_COLS)
				.from(collection)
				.where(whereClause)
				.orderBy(...orderBy)
				.limit(PAGE_SIZE)
				.offset((page - 1) * PAGE_SIZE)
		]);
		total = countRow?.cnt ?? 0;
		const assignedMap = await getAssignedMap(rows.map((row) => row.id));

		const enriched = enrichWithScryfall(rows);

		entries = enriched.map((r) => {
			const location = computeLocation(
				r.typeLine ?? '',
				r.manaCost,
				r.priceUsd,
				r.locationOverride
			);
			const assigned = assignedMap.get(r.id) ?? 0;
			return { ...r, location, available: r.quantity - assigned, assigned };
		});
	}

	return {
		entries,
		search,
		locationFilter,
		tagFilter,
		page,
		pageSize: PAGE_SIZE,
		total,
		oldestPriceTs,
		sort: ast.sort,
		searchError: null
	};
};

export const actions: Actions = {
	refreshPrices: async () => {
		try {
			const refreshed = await refreshPricesFromBulkData();
			return { success: true, refreshed };
		} catch (e) {
			return fail(500, { error: String(e) });
		}
	},
	setLocationOverride: async ({ request }) => {
		const data = await request.formData();
		const id = parseInt(data.get('id') as string);
		const override = (data.get('override') as string) || null;
		if (!id) return fail(400, { error: 'Missing id' });
		if (override && !isWritableCardLocation(override)) {
			return fail(400, { error: 'Invalid location' });
		}
		await db.update(collection).set({ locationOverride: override }).where(eq(collection.id, id));
		return { success: true };
	},
	bulkFileHoldingBox: async ({ request }) => {
		const data = await request.formData();
		const ids = String(data.get('ids') ?? '')
			.split(',')
			.map((value) => Number.parseInt(value, 10))
			.filter((value) => Number.isInteger(value) && value > 0);
		const location = String(data.get('location') ?? '');

		if (ids.length === 0) return fail(400, { error: 'Select at least one Holding Box row' });
		if (!isWritableCardLocation(location) || location === 'holding_box' || location === 'unknown') {
			return fail(400, { error: 'Choose a filing destination' });
		}

		const stagedRows = await db
			.select({ id: collection.id })
			.from(collection)
			.where(and(inArray(collection.id, ids), eq(collection.locationOverride, 'holding_box')));
		if (stagedRows.length !== ids.length) {
			return fail(409, {
				error: 'Some selected rows are no longer in the Holding Box. Refresh and try again.'
			});
		}

		await db
			.update(collection)
			.set({ locationOverride: location })
			.where(inArray(collection.id, ids));
		return { success: true, filed: ids.length };
	},
	setTags: async ({ request }) => {
		const data = await request.formData();
		const id = parseInt(data.get('id') as string);
		const rawTags = ((data.get('tags') as string) ?? '').trim();
		const tags = rawTags
			? JSON.stringify(
					rawTags
						.split(',')
						.map((t) => t.trim())
						.filter(Boolean)
				)
			: null;
		await db.update(collection).set({ tags }).where(eq(collection.id, id));
		return { success: true };
	},
	updateQuantity: async ({ request }) => {
		const data = await request.formData();
		const id = parseInt(data.get('id') as string);
		const qty = parseInt(data.get('quantity') as string);
		if (!id || isNaN(qty) || qty < 1) return fail(400, { error: 'Quantity must be at least 1' });
		await db.update(collection).set({ quantity: qty }).where(eq(collection.id, id));
		return { success: true };
	},
	updatePrinting: async ({ request }) => {
		const data = await request.formData();
		const id = parseInt(data.get('id') as string);
		const setCode = ((data.get('setCode') as string) ?? '').trim().toLowerCase();
		const collectorNumber = ((data.get('collectorNumber') as string) ?? '').trim();
		if (!id || !setCode || !collectorNumber)
			return fail(400, { error: 'Set code and collector number are required' });
		const cached = getBySetColl(setCode, collectorNumber);
		await db
			.update(collection)
			.set({
				setCode,
				collectorNumber,
				scryfallId: cached?.id ?? null,
				oracleId: cached?.oracle_id ?? null,
				name:
					cached?.name ??
					(await db
						.select({ name: collection.name })
						.from(collection)
						.where(eq(collection.id, id))
						.then((r) => r[0]?.name ?? ''))
			})
			.where(eq(collection.id, id));
		invalidateCollectionSearchCandidates();
		return { success: true };
	},
	deleteEntry: async ({ request }) => {
		const data = await request.formData();
		const id = parseInt(data.get('id') as string);
		if (!id) return fail(400, { error: 'Missing id' });
		const [{ cnt }] = await db
			.select({ cnt: count() })
			.from(cardAssignments)
			.where(eq(cardAssignments.collectionId, id));
		if (cnt > 0)
			return fail(409, {
				error: `Cannot delete — this copy is assigned to ${cnt} deck slot${cnt === 1 ? '' : 's'}. Unassign it first.`
			});
		await db.delete(collection).where(eq(collection.id, id));
		invalidateCollectionSearchCandidates();
		return { success: true };
	}
};
