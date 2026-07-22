import { describe, expect, it } from 'vitest';
import {
	normalizePendingRemovalRequests,
	ownedCollectionIdsForReturn,
	PendingRemovalError
} from './deck-return-rules';

describe('return task batch normalization', () => {
	it('deduplicates tasks and sorts by deck before pending ID', () => {
		expect(
			normalizePendingRemovalRequests([
				{ deckId: 9, pendingRemovalId: 4 },
				{ deckId: 2, pendingRemovalId: 7 },
				{ deckId: 9, pendingRemovalId: 3 },
				{ deckId: 9, pendingRemovalId: 4 }
			])
		).toEqual([
			{ deckId: 2, pendingRemovalId: 7 },
			{ deckId: 9, pendingRemovalId: 3 },
			{ deckId: 9, pendingRemovalId: 4 }
		]);
	});

	it('rejects invalid IDs', () => {
		expect(() => normalizePendingRemovalRequests([{ deckId: 0, pendingRemovalId: 1 }])).toThrow(
			PendingRemovalError
		);
	});

	it('rejects the same task paired with conflicting decks', () => {
		expect(() =>
			normalizePendingRemovalRequests([
				{ deckId: 2, pendingRemovalId: 8 },
				{ deckId: 3, pendingRemovalId: 8 }
			])
		).toThrow('Conflicting return task.');
	});
});

describe('owned return destinations', () => {
	it('selects only owned collection copies being removed', () => {
		expect(
			ownedCollectionIdsForReturn(
				[
					{ id: 1, status: 'assigned', collectionId: 11 },
					{ id: 2, status: 'proxied', collectionId: null },
					{ id: 4, status: 'assigned', collectionId: 14 }
				],
				[1, 2]
			)
		).toEqual([11]);
	});

	it('deduplicates a collection copy defensively', () => {
		expect(
			ownedCollectionIdsForReturn(
				[
					{ id: 1, status: 'assigned', collectionId: 11 },
					{ id: 2, status: 'assigned', collectionId: 11 }
				],
				[1, 2]
			)
		).toEqual([11]);
	});
});
