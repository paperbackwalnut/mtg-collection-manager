import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { db } from '$lib/server/db/index';
import { collection, cardAssignments } from '$lib/server/db/schema';
import { parseMoxfieldCSV } from '$lib/server/moxfield';
import { enrichFromBulkData } from '$lib/server/scryfall';
import { getOracleIdsByScryfallId } from '$lib/server/collection-oracle-id';
import { eq, isNull, count, sql, or, inArray } from 'drizzle-orm';
import { invalidateCollectionSearchCandidates } from '$lib/server/collection-search-candidates';
import {
	importedLocationOverride,
	parseCollectionImportDestination,
	syncedLocationOverride
} from '$lib/server/collection-import-location';
import {
	buildCollectionImportPreview,
	type CollectionImportMode
} from '$lib/server/collection-import-preview';

export const load: PageServerLoad = async () => {
	const [{ cnt }] = await db.select({ cnt: count() }).from(collection);
	const [{ unenriched }] = await db
		.select({ unenriched: count() })
		.from(collection)
		.where(isNull(collection.scryfallId));
	return { hasCollection: cnt > 0, collectionCount: cnt, unenrichedCount: unenriched };
};

function importFileHash(contents: string): string {
	return createHash('sha256').update(contents).digest('hex');
}

export const actions: Actions = {
	preview: async ({ request }) => {
		const formData = await request.formData();
		const file = formData.get('csv') as File | null;
		const mode = String(formData.get('mode') ?? 'merge') as CollectionImportMode;
		const destination = parseCollectionImportDestination(formData.get('destination') ?? 'auto');
		if (!file || file.size === 0) return fail(400, { error: 'Please select a CSV file.' });
		if (!['merge', 'sync', 'replace'].includes(mode)) {
			return fail(400, { error: 'Please select a valid import mode.' });
		}
		if (!destination) return fail(400, { error: 'Please select a valid import destination.' });

		let rows;
		let csvText: string;
		try {
			csvText = await file.text();
			rows = parseMoxfieldCSV(csvText);
		} catch {
			return fail(400, { error: 'Could not read file.' });
		}
		if (rows.length === 0) {
			return fail(400, {
				error:
					'No valid rows found. Expected a supported collection CSV with name, set, collector number, and quantity columns.'
			});
		}

		const existingEntries = await db.select().from(collection);
		const activeRows = await db
			.selectDistinct({ collectionId: cardAssignments.collectionId })
			.from(cardAssignments)
			.where(sql`${cardAssignments.collectionId} IS NOT NULL`);
		const preview = buildCollectionImportPreview(
			rows,
			existingEntries,
			new Set(activeRows.map((row) => row.collectionId)),
			destination,
			mode
		);

		return {
			preview: true,
			previewMode: mode,
			previewFileName: file.name,
			previewHash: importFileHash(csvText),
			previewDestination: destination,
			...preview
		};
	},

	import: async ({ request }) => {
		const formData = await request.formData();
		const file = formData.get('csv') as File | null;
		const mode = String(formData.get('mode') ?? 'merge');
		const destination = parseCollectionImportDestination(formData.get('destination') ?? 'auto');

		if (!file || file.size === 0) {
			return fail(400, { error: 'Please select a CSV file.' });
		}
		if (!destination) {
			return fail(400, { error: 'Please select a valid import destination.' });
		}
		if (!['merge', 'sync', 'replace'].includes(mode)) {
			return fail(400, { error: 'Please select a valid import mode.' });
		}
		if (formData.get('confirmed') !== '1') {
			return fail(400, { error: 'Preview and confirm the changes before importing.' });
		}

		let csvText: string;
		try {
			csvText = await file.text();
		} catch {
			return fail(400, { error: 'Could not read file.' });
		}
		if (formData.get('previewHash') !== importFileHash(csvText)) {
			return fail(400, { error: 'The selected file changed after preview. Preview it again.' });
		}

		console.log(`[Import] Parsing CSV (${(file.size / 1024).toFixed(0)} KB)…`);
		const rows = parseMoxfieldCSV(csvText);
		if (rows.length === 0) {
			return fail(400, {
				error:
					'No valid rows found. Check that the CSV has name, set, collector number, and quantity columns.'
			});
		}
		console.log(`[Import] Parsed ${rows.length} rows from CSV`);

		if (mode === 'replace') {
			console.log('[Import] Mode: REPLACE (full wipe + re-import)');
			// Nuclear option: wipe everything, enrich all, start fresh.
			const identifiers = [
				...new Map(
					rows
						.filter((r) => r.edition && r.collectorNumber)
						.map((r) => [
							`${r.edition}:${r.collectorNumber}`,
							{ setCode: r.edition, collectorNumber: r.collectorNumber }
						])
				).values()
			];

			console.log(
				`[Import] Enriching ${identifiers.length} unique set+collector combos via Scryfall…`
			);
			let scryfallMap = new Map<string, string>();
			let notFoundCount = 0;
			try {
				const { result, notFound } = await enrichFromBulkData(identifiers);
				scryfallMap = result;
				notFoundCount = notFound.length;
				console.log(
					`[Import] Scryfall: matched ${scryfallMap.size}/${identifiers.length}, ${notFoundCount} not found`
				);
			} catch (e) {
				console.error('[Import] Scryfall enrichment error:', e);
			}
			const oracleIds = getOracleIdsByScryfallId(scryfallMap.values());

			const toInsertReplace = rows
				.filter((r) => r.name && r.edition)
				.map((r) => {
					const scryfallId = scryfallMap.get(`${r.edition}:${r.collectorNumber}`) ?? null;
					return {
						scryfallId,
						oracleId: scryfallId ? (oracleIds.get(scryfallId) ?? null) : null,
						name: r.name,
						setCode: r.edition,
						collectorNumber: r.collectorNumber,
						condition: r.condition,
						language: r.language,
						foil: r.foil,
						quantity: r.count,
						purchasePrice: r.purchasePrice,
						locationOverride: importedLocationOverride(r.isProxy, destination),
						tags: r.tags ? JSON.stringify(r.tags.split(',').map((t) => t.trim())) : null
					};
				});
			const skipped = rows.length - toInsertReplace.length;
			const imported = toInsertReplace.length;
			const ICHUNK = 500;
			db.transaction((tx) => {
				tx.update(cardAssignments)
					.set({ status: 'unassigned', collectionId: null, pulled: false, printStatus: null })
					.where(sql`${cardAssignments.collectionId} IS NOT NULL`)
					.run();
				tx.delete(collection).run();
				for (let i = 0; i < toInsertReplace.length; i += ICHUNK) {
					tx.insert(collection)
						.values(toInsertReplace.slice(i, i + ICHUNK))
						.run();
				}
			});
			console.log(`[Import] Done: ${imported} imported, ${skipped} skipped`);
			invalidateCollectionSearchCandidates();
			return {
				success: true,
				mode: 'replace',
				imported,
				skipped,
				unchanged: 0,
				total: rows.length,
				scryfallMatched: scryfallMap.size,
				scryfallNotFound: notFoundCount,
				updated: 0,
				removed: 0,
				kept: 0
			};
		}

		// ── Merge/synchronize modes ───────────────────────────────────────────
		console.log(`[Import] Mode: ${mode.toUpperCase()}`);
		console.log('[Import] Loading existing collection from DB…');
		const existingEntries = await db
			.select({
				id: collection.id,
				name: collection.name,
				setCode: collection.setCode,
				collectorNumber: collection.collectorNumber,
				foil: collection.foil,
				quantity: collection.quantity,
				purchasePrice: collection.purchasePrice,
				scryfallId: collection.scryfallId,
				oracleId: collection.oracleId,
				locationOverride: collection.locationOverride
			})
			.from(collection);
		console.log(`[Import] Loaded ${existingEntries.length} existing entries`);

		const existingMap = new Map(
			existingEntries.map((e) => [
				`${e.name}:${e.setCode}:${e.collectorNumber}:${String(e.foil)}`,
				e
			])
		);

		// First pass: classify each CSV row without hitting Scryfall yet
		const newRows: typeof rows = [];
		const needEnrichRows: typeof rows = []; // existing but missing scryfallId
		const csvKeys = new Set<string>();

		for (const row of rows) {
			if (!row.name || !row.edition) continue;
			const key = `${row.name}:${row.edition}:${row.collectorNumber}:${String(row.foil)}`;
			csvKeys.add(key);
			const existing = existingMap.get(key);
			if (!existing) {
				newRows.push(row);
			} else if (!existing.scryfallId) {
				needEnrichRows.push(row);
			}
		}
		console.log(
			`[Import] Classified: ${newRows.length} new, ${needEnrichRows.length} need enrichment, ${existingEntries.length - needEnrichRows.length} already known`
		);

		// Only call Scryfall for cards that actually need it
		const enrichTargets = [...newRows, ...needEnrichRows];
		const identifiers = [
			...new Map(
				enrichTargets
					.filter((r) => r.edition && r.collectorNumber)
					.map((r) => [
						`${r.edition}:${r.collectorNumber}`,
						{ setCode: r.edition, collectorNumber: r.collectorNumber }
					])
			).values()
		];

		let scryfallMap = new Map<string, string>();
		let notFoundCount = 0;
		if (identifiers.length > 0) {
			console.log(`[Import] Enriching ${identifiers.length} cards via Scryfall…`);
			try {
				const { result, notFound } = await enrichFromBulkData(identifiers);
				scryfallMap = result;
				notFoundCount = notFound.length;
				console.log(
					`[Import] Scryfall: matched ${scryfallMap.size}/${identifiers.length}, ${notFoundCount} not found`
				);
			} catch (e) {
				console.error('[Import] Scryfall enrichment error:', e);
			}
		} else {
			console.log('[Import] No Scryfall enrichment needed — all cards already cached');
		}
		const oracleIds = getOracleIdsByScryfallId([
			...existingEntries.map((entry) => entry.scryfallId),
			...scryfallMap.values()
		]);

		// Second pass: classify all rows first, then apply in bulk
		console.log('[Import] Classifying changes…');
		let imported = 0,
			updated = 0,
			unchanged = 0,
			skipped = 0;

		type PendingInsert = typeof collection.$inferInsert;
		type PendingUpdate = {
			id: number;
			qty: number | null;
			chgPrice: boolean;
			price: number | null;
			scid: string | null;
			oid: string | null;
			chgLoc: boolean;
			loc: string | null;
		};
		const pendingInserts: PendingInsert[] = [];
		const pendingUpdates: PendingUpdate[] = [];

		for (const row of rows) {
			if (!row.name || !row.edition) {
				skipped++;
				continue;
			}
			const rowKey = `${row.name}:${row.edition}:${row.collectorNumber}:${String(row.foil)}`;
			const existing = existingMap.get(rowKey);
			const scryfallId =
				scryfallMap.get(`${row.edition}:${row.collectorNumber}`) ?? existing?.scryfallId ?? null;
			const oracleId = scryfallId ? (oracleIds.get(scryfallId) ?? null) : null;

			if (existing) {
				const quantityChanged = existing.quantity !== row.count;
				const priceChanged = existing.purchasePrice !== row.purchasePrice;
				const scryfallUpdated = !!(scryfallId && !existing.scryfallId);
				const oracleUpdated = !!(oracleId && !existing.oracleId);
				const correctLoc = syncedLocationOverride(
					existing.locationOverride,
					row.isProxy,
					destination
				);
				const locChanged = existing.locationOverride !== correctLoc;
				if (quantityChanged || priceChanged || scryfallUpdated || oracleUpdated || locChanged) {
					pendingUpdates.push({
						id: existing.id,
						qty: quantityChanged ? row.count : null,
						chgPrice: priceChanged,
						price: priceChanged ? (row.purchasePrice ?? null) : null,
						scid: scryfallUpdated ? scryfallId : null,
						oid: oracleUpdated ? oracleId : null,
						chgLoc: locChanged,
						loc: locChanged ? correctLoc : null
					});
					updated++;
				} else {
					unchanged++;
				}
			} else {
				pendingInserts.push({
					scryfallId,
					oracleId,
					name: row.name,
					setCode: row.edition,
					collectorNumber: row.collectorNumber,
					condition: row.condition,
					language: row.language,
					foil: row.foil,
					quantity: row.count,
					purchasePrice: row.purchasePrice,
					locationOverride: importedLocationOverride(row.isProxy, destination),
					tags: row.tags ? JSON.stringify(row.tags.split(',').map((t) => t.trim())) : null
				});
				imported++;
			}
		}
		console.log(
			`[Import] Classified: ${imported} inserts, ${updated} updates, ${unchanged} unchanged, ${skipped} skipped`
		);

		// Synchronize removes entries absent from the CSV unless actively assigned.
		// One query to get all collection IDs with active assignments — avoids N round-trips.
		console.log(
			mode === 'sync' ? '[Import] Checking for removals…' : '[Import] Merge mode: removals disabled'
		);
		const activeAssignRows = await db
			.selectDistinct({ collectionId: cardAssignments.collectionId })
			.from(cardAssignments)
			.where(sql`${cardAssignments.collectionId} IS NOT NULL`);
		const activeCollectionIds = new Set(
			activeAssignRows.map((r) => r.collectionId).filter((id): id is number => id !== null)
		);

		let removed = 0,
			kept = 0;
		const toDelete: number[] = [];
		for (const entry of mode === 'sync' ? existingEntries : []) {
			const entryKey = `${entry.name}:${entry.setCode}:${entry.collectorNumber}:${String(entry.foil)}`;
			if (!csvKeys.has(entryKey)) {
				if (activeCollectionIds.has(entry.id)) {
					kept++;
				} else {
					toDelete.push(entry.id);
					removed++;
				}
			}
		}

		console.log('[Import] Applying changes atomically…');
		const ICHUNK = 500;
		db.transaction((tx) => {
			for (let i = 0; i < pendingInserts.length; i += ICHUNK) {
				tx.insert(collection)
					.values(pendingInserts.slice(i, i + ICHUNK))
					.run();
			}
			for (const update of pendingUpdates) {
				tx.update(collection)
					.set({
						...(update.qty !== null ? { quantity: update.qty } : {}),
						...(update.chgPrice ? { purchasePrice: update.price } : {}),
						...(update.scid !== null ? { scryfallId: update.scid } : {}),
						...(update.oid !== null ? { oracleId: update.oid } : {}),
						...(update.chgLoc ? { locationOverride: update.loc } : {})
					})
					.where(eq(collection.id, update.id))
					.run();
			}
			for (let i = 0; i < toDelete.length; i += ICHUNK) {
				tx.delete(collection)
					.where(inArray(collection.id, toDelete.slice(i, i + ICHUNK)))
					.run();
			}
		});
		console.log(`[Import] Removals: ${removed} removed, ${kept} kept (still in decks)`);
		console.log(
			`[Import] ✓ Complete: ${imported} added, ${updated} updated, ${unchanged} unchanged, ${removed} removed`
		);
		if (imported > 0 || updated > 0 || removed > 0) invalidateCollectionSearchCandidates();

		return {
			success: true,
			mode,
			imported,
			updated,
			unchanged,
			removed,
			kept,
			skipped,
			total: rows.length,
			scryfallMatched: scryfallMap.size,
			scryfallNotFound: notFoundCount
		};
	},

	enrichExisting: async () => {
		const unenriched = await db
			.select({
				id: collection.id,
				setCode: collection.setCode,
				collectorNumber: collection.collectorNumber,
				scryfallId: collection.scryfallId
			})
			.from(collection)
			.where(or(isNull(collection.scryfallId), isNull(collection.oracleId)));

		if (unenriched.length === 0) {
			return { enrichSuccess: true, enriched: 0, enrichNotFound: 0 };
		}

		const identifiers = unenriched
			.filter((r) => !r.scryfallId && r.setCode && r.collectorNumber)
			.map((r) => ({ setCode: r.setCode!, collectorNumber: r.collectorNumber! }));

		let scryfallMap: Map<string, string>;
		let notFoundArr: Array<{ setCode: string; collectorNumber: string }>;
		try {
			// Use bulk data (local file or streaming download) — avoids rate limiting for large collections
			const { result, notFound } = await enrichFromBulkData(identifiers);
			scryfallMap = result;
			notFoundArr = notFound;
		} catch (e) {
			console.error('Scryfall enrichment error:', e);
			return fail(500, {
				error: `Scryfall enrichment failed: ${e instanceof Error ? e.message : String(e)}`
			});
		}

		const oracleIds = getOracleIdsByScryfallId([
			...unenriched.map((row) => row.scryfallId),
			...scryfallMap.values()
		]);
		let enriched = 0;
		for (const row of unenriched) {
			if (!row.setCode || !row.collectorNumber) continue;
			const key = `${row.setCode}:${row.collectorNumber}`;
			const scryfallId = row.scryfallId ?? scryfallMap.get(key);
			if (scryfallId) {
				await db
					.update(collection)
					.set({ scryfallId, oracleId: oracleIds.get(scryfallId) ?? null })
					.where(eq(collection.id, row.id));
				enriched++;
			}
		}

		const notFoundCount = notFoundArr.length;
		if (enriched > 0) invalidateCollectionSearchCandidates();
		return { enrichSuccess: true, enriched, enrichNotFound: notFoundCount };
	}
};
