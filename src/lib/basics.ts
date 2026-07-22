/** Canonical basic land names. Used server-side (shortfalls/missing) and client-side (Manager). */
export const BASIC_LAND_NAMES = new Set([
	'Plains',
	'Island',
	'Swamp',
	'Mountain',
	'Forest',
	'Wastes',
	'Snow-Covered Plains',
	'Snow-Covered Island',
	'Snow-Covered Swamp',
	'Snow-Covered Mountain',
	'Snow-Covered Forest'
]);

export function isBasicLand(cardName: string): boolean {
	return BASIC_LAND_NAMES.has(cardName);
}
