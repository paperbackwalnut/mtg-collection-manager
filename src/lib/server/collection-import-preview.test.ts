import { describe, expect, it } from 'vitest';
import { buildCollectionImportPreview } from './collection-import-preview';
import type { MoxfieldRow } from './moxfield';

const row = (overrides: Partial<MoxfieldRow> = {}): MoxfieldRow => ({
	count: 2,
	name: 'Sol Ring',
	edition: 'cmr',
	condition: 'NM',
	language: 'English',
	foil: false,
	tags: '',
	collectorNumber: '319',
	isProxy: false,
	purchasePrice: 1.5,
	...overrides
});

const existing = [
	{
		id: 1,
		name: 'Sol Ring',
		setCode: 'cmr',
		collectorNumber: '319',
		foil: false,
		quantity: 1,
		purchasePrice: 1.5,
		locationOverride: null
	},
	{
		id: 2,
		name: 'Island',
		setCode: 'm21',
		collectorNumber: '265',
		foil: false,
		quantity: 4,
		purchasePrice: null,
		locationOverride: null
	}
];

describe('collection import preview', () => {
	it('never reports removals in merge mode', () => {
		const preview = buildCollectionImportPreview([row()], existing, new Set(), 'auto', 'merge');
		expect(preview).toMatchObject({ updated: 1, removeCandidates: 0, protectedRemovals: 0 });
	});

	it('separates removable and assigned entries during synchronization', () => {
		const removable = buildCollectionImportPreview([row()], existing, new Set(), 'auto', 'sync');
		expect(removable.removeCandidates).toBe(1);

		const protectedPreview = buildCollectionImportPreview(
			[row()],
			existing,
			new Set([2]),
			'auto',
			'sync'
		);
		expect(protectedPreview.removeCandidates).toBe(0);
		expect(protectedPreview.protectedRemovals).toBe(1);
	});

	it('shows the entire existing collection as replaced in replace mode', () => {
		const preview = buildCollectionImportPreview(
			[row({ isProxy: true })],
			existing,
			new Set([2]),
			'auto',
			'replace'
		);
		expect(preview.removeCandidates).toBe(2);
		expect(preview.proxyRows).toBe(1);
	});
});
