import { describe, expect, it } from 'vitest';
import { resolveMissingOracleIds } from '../collection-oracle-id';

describe('resolveMissingOracleIds', () => {
	it('returns updates only for missing Oracle IDs with a cached mapping', () => {
		const updates = resolveMissingOracleIds(
			[
				{ id: 1, scryfallId: 'printing-a', oracleId: null },
				{ id: 2, scryfallId: 'printing-b', oracleId: 'already-set' },
				{ id: 3, scryfallId: null, oracleId: null },
				{ id: 4, scryfallId: 'printing-missing', oracleId: null }
			],
			new Map([['printing-a', 'oracle-a']])
		);

		expect(updates).toEqual([{ id: 1, oracleId: 'oracle-a' }]);
	});

	it('preserves separate collection rows that share one Oracle identity', () => {
		const updates = resolveMissingOracleIds(
			[
				{ id: 10, scryfallId: 'printing-a', oracleId: null },
				{ id: 11, scryfallId: 'printing-b', oracleId: null }
			],
			new Map([
				['printing-a', 'oracle-shared'],
				['printing-b', 'oracle-shared']
			])
		);

		expect(updates).toEqual([
			{ id: 10, oracleId: 'oracle-shared' },
			{ id: 11, oracleId: 'oracle-shared' }
		]);
	});
});
