export const ORDER_SOURCES = ['tcgplayer', 'ebay', 'lgs', 'other'] as const;

export type OrderSource = (typeof ORDER_SOURCES)[number];

const ORDER_SOURCE_SET = new Set<string>(ORDER_SOURCES);

export function normalizeOrderSource(value: FormDataEntryValue | null): OrderSource {
	return typeof value === 'string' && ORDER_SOURCE_SET.has(value)
		? (value as OrderSource)
		: 'other';
}
