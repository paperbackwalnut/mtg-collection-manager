export const CURRENT_BACKUP_VERSION = 7;

export function hasRequiredProxyInventoryData(version: number, proxyInventory: unknown): boolean {
	return version < 5 || Array.isArray(proxyInventory);
}

export function hasRequiredShoppingListData(version: number, shoppingList: unknown): boolean {
	return version < 6 || Array.isArray(shoppingList);
}
