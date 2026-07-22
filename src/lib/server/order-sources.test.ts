import { describe, expect, it } from 'vitest';
import { normalizeOrderSource } from './order-sources';

describe('order source normalization', () => {
	it.each(['tcgplayer', 'ebay', 'lgs', 'other'])('accepts supported source %s', (source) =>
		expect(normalizeOrderSource(source)).toBe(source)
	);

	it.each(['marketplace', 'unknown-source', '', null])(
		'normalizes unsupported source %s to other',
		(source) => expect(normalizeOrderSource(source)).toBe('other')
	);
});
