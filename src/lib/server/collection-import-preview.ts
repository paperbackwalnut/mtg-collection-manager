import type { MoxfieldRow } from './moxfield';
import {
	syncedLocationOverride,
	type CollectionImportDestination
} from './collection-import-location';

export type CollectionImportMode = 'merge' | 'sync' | 'replace';

export interface ExistingImportEntry {
	id: number;
	name: string;
	setCode: string;
	collectorNumber: string;
	foil: boolean | null;
	quantity: number;
	purchasePrice: number | null;
	locationOverride: string | null;
}

export function collectionImportKey(entry: {
	name: string;
	setCode?: string;
	edition?: string;
	collectorNumber: string;
	foil: boolean | null;
}): string {
	return `${entry.name}:${entry.setCode ?? entry.edition}:${entry.collectorNumber}:${String(entry.foil)}`;
}

export function buildCollectionImportPreview(
	rows: MoxfieldRow[],
	existingEntries: ExistingImportEntry[],
	activeCollectionIds: Set<number | null>,
	destination: CollectionImportDestination,
	mode: CollectionImportMode
) {
	const existingMap = new Map(existingEntries.map((entry) => [collectionImportKey(entry), entry]));
	const csvKeys = new Set<string>();
	let added = 0;
	let updated = 0;
	let unchanged = 0;
	let proxyRows = 0;
	for (const row of rows) {
		const key = collectionImportKey(row);
		csvKeys.add(key);
		if (row.isProxy) proxyRows++;
		const existing = existingMap.get(key);
		if (!existing) {
			added++;
			continue;
		}
		const nextLocation = syncedLocationOverride(
			existing.locationOverride,
			row.isProxy,
			destination
		);
		if (
			existing.quantity !== row.count ||
			existing.purchasePrice !== row.purchasePrice ||
			existing.locationOverride !== nextLocation
		)
			updated++;
		else unchanged++;
	}

	let removable = 0;
	let protectedRemovals = 0;
	for (const entry of existingEntries) {
		if (!csvKeys.has(collectionImportKey(entry))) {
			if (activeCollectionIds.has(entry.id)) protectedRemovals++;
			else removable++;
		}
	}

	return {
		total: rows.length,
		added,
		updated,
		unchanged,
		proxyRows,
		removeCandidates: mode === 'sync' ? removable : mode === 'replace' ? existingEntries.length : 0,
		protectedRemovals: mode === 'sync' ? protectedRemovals : 0,
		currentCount: existingEntries.length
	};
}
