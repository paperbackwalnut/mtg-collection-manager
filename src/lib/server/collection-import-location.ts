import type { CardLocation } from '$lib/types';

export type CollectionImportDestination = 'auto' | 'holding_box';

export function parseCollectionImportDestination(
	value: FormDataEntryValue | null
): CollectionImportDestination | null {
	return value === 'auto' || value === 'holding_box' ? value : null;
}

export function importedLocationOverride(
	isProxy: boolean,
	destination: CollectionImportDestination
): CardLocation | null {
	if (isProxy) return 'proxy_box';
	return destination === 'holding_box' ? 'holding_box' : null;
}

export function syncedLocationOverride(
	existingOverride: string | null,
	isProxy: boolean,
	destination: CollectionImportDestination
): string | null {
	if (isProxy) return 'proxy_box';
	if (existingOverride === 'proxy_box') {
		return importedLocationOverride(false, destination);
	}
	return existingOverride;
}
