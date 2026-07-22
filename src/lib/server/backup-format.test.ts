import { describe, expect, it } from 'vitest';
import {
	CURRENT_BACKUP_VERSION,
	hasRequiredProxyInventoryData,
	hasRequiredShoppingListData
} from './backup-format';

describe('backup format v7', () => {
	it('identifies version 7 as the current format', () => {
		expect(CURRENT_BACKUP_VERSION).toBe(7);
	});

	it('requires proxy inventory data for version 5 and newer', () => {
		expect(hasRequiredProxyInventoryData(5, undefined)).toBe(false);
		expect(hasRequiredProxyInventoryData(5, [])).toBe(true);
		expect(hasRequiredProxyInventoryData(6, [])).toBe(true);
	});

	it('keeps version 4 backups restorable without proxy inventory', () => {
		expect(hasRequiredProxyInventoryData(4, undefined)).toBe(true);
	});

	it('requires shopping list data for version 6 and newer', () => {
		expect(hasRequiredShoppingListData(6, undefined)).toBe(false);
		expect(hasRequiredShoppingListData(6, [])).toBe(true);
		expect(hasRequiredShoppingListData(7, [])).toBe(true);
	});

	it('keeps version 5 backups restorable without shopping list data', () => {
		expect(hasRequiredShoppingListData(5, undefined)).toBe(true);
	});
});
