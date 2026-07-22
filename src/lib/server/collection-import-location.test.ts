import { describe, expect, it } from 'vitest';
import {
	importedLocationOverride,
	parseCollectionImportDestination,
	syncedLocationOverride
} from './collection-import-location';
import { computeLocation } from './location';
import { LOCATION_LABELS, LOCATION_ORDER, isCardLocation, isWritableCardLocation } from '../types';

describe('collection import locations', () => {
	it('accepts only supported import destinations', () => {
		expect(parseCollectionImportDestination('auto')).toBe('auto');
		expect(parseCollectionImportDestination('holding_box')).toBe('holding_box');
		expect(parseCollectionImportDestination('box_w')).toBeNull();
		expect(parseCollectionImportDestination(null)).toBeNull();
	});

	it('places new non-proxy cards in the selected destination', () => {
		expect(importedLocationOverride(false, 'auto')).toBeNull();
		expect(importedLocationOverride(false, 'holding_box')).toBe('holding_box');
	});

	it('maps Moxfield proxy rows to the supported proxy location', () => {
		expect(importedLocationOverride(true, 'holding_box')).toBe('proxy_box');
		expect(syncedLocationOverride('holding_box', true, 'auto')).toBe('proxy_box');
	});

	it('preserves existing manual locations during sync', () => {
		expect(syncedLocationOverride('holding_box', false, 'auto')).toBe('holding_box');
		expect(syncedLocationOverride('box_u', false, 'holding_box')).toBe('box_u');
		expect(syncedLocationOverride(null, false, 'holding_box')).toBeNull();
	});

	it('moves a former Moxfield proxy to the selected destination', () => {
		expect(syncedLocationOverride('proxy_box', false, 'auto')).toBeNull();
	});

	it('registers Holding Box as a normal location override', () => {
		expect(isCardLocation('holding_box')).toBe(true);
		expect(LOCATION_LABELS.holding_box).toBe('Holding Box');
		expect(LOCATION_ORDER).toContain('holding_box');
		expect(computeLocation('Land', null, 50, 'holding_box')).toBe('holding_box');
	});

	it('accepts only supported writable locations', () => {
		expect(isWritableCardLocation('proxy_box')).toBe(true);
		expect(isWritableCardLocation('removed-location')).toBe(false);
	});
});
