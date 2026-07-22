import { describe, expect, it } from 'vitest';
import {
	canRemoveAssignment,
	planAssignmentReduction,
	selectAssignmentsForPendingRemoval
} from '../deck-mutation-rules';
import { findSyncRemovalConflicts, planSyncRemovals } from '../deck-sync-safety';

describe('deck assignment removal safety', () => {
	it('allows only a completely unassigned and unpacked slot', () => {
		expect(
			canRemoveAssignment({
				id: 1,
				status: 'unassigned',
				pulled: false,
				collectionId: null
			})
		).toBe(true);
		for (const assignment of [
			{ id: 2, status: 'assigned', pulled: false, collectionId: 10 },
			{ id: 3, status: 'proxied', pulled: false, collectionId: null },
			{ id: 5, status: 'unassigned', pulled: true, collectionId: null },
			{ id: 6, status: 'unassigned', pulled: false, collectionId: 10 }
		]) {
			expect(canRemoveAssignment(assignment)).toBe(false);
		}
	});

	it('selects removable slots without consuming protected assignments', () => {
		const plan = planAssignmentReduction(
			[
				{ id: 3, status: 'assigned', pulled: true, collectionId: 20 },
				{ id: 2, status: 'unassigned', pulled: false, collectionId: null },
				{ id: 1, status: 'unassigned', pulled: false, collectionId: null }
			],
			2
		);
		expect(plan.removeIds).toEqual([1, 2]);
		expect(plan.protectedAssignments).toEqual([]);
	});

	it('reports protected copies without pretending a partial reduction is safe', () => {
		const plan = planAssignmentReduction(
			[
				{ id: 1, status: 'unassigned', pulled: false, collectionId: null },
				{ id: 2, status: 'assigned', pulled: false, collectionId: 20 },
				{ id: 3, status: 'proxied', pulled: true, collectionId: null }
			],
			3
		);
		expect(plan.removeIds).toEqual([1]);
		expect(plan.protectedAssignments.map((assignment) => assignment.id)).toEqual([2, 3]);
	});

	it('treats a linked or packed unassigned slot as protected', () => {
		expect(
			canRemoveAssignment({
				id: 1,
				status: 'unassigned',
				pulled: false,
				collectionId: 42
			})
		).toBe(false);
		expect(
			canRemoveAssignment({
				id: 2,
				status: 'unassigned',
				pulled: true,
				collectionId: null
			})
		).toBe(false);
	});
});

describe('Moxfield sync removal preflight', () => {
	const cards = [
		{ id: 10, cardName: 'Counterspell', board: 'main' },
		{ id: 20, cardName: 'Island', board: 'main' }
	];

	it('automatically releases an assigned copy that is not packed', () => {
		const conflicts = findSyncRemovalConflicts(
			cards,
			[
				{
					id: 100,
					deckCardId: 10,
					status: 'assigned',
					pulled: false,
					collectionId: 5
				}
			],
			[{ cardName: 'Island', board: 'main', quantity: 1 }]
		);
		expect(conflicts).toEqual([]);
	});

	it('keeps a packed assigned copy as physical return work', () => {
		const plans = planSyncRemovals(
			cards,
			[
				{
					id: 100,
					deckCardId: 10,
					status: 'assigned',
					pulled: true,
					collectionId: 5
				}
			],
			[{ cardName: 'Island', board: 'main', quantity: 1 }]
		);
		expect(plans[0]).toMatchObject({
			cardName: 'Counterspell',
			requestedRemoval: 1,
			removableCount: 0,
			removeIds: [],
			remainingQuantity: 1,
			protectedAssignments: [{ id: 100, pulled: true }]
		});
	});

	it('automatically releases unpacked proxy assignments', () => {
		const plans = planSyncRemovals(
			[cards[0]],
			[
				{
					id: 100,
					deckCardId: 10,
					status: 'proxied',
					pulled: false,
					collectionId: null
				}
			],
			[]
		);
		expect(plans[0]).toMatchObject({
			removableCount: 1,
			removeIds: [100],
			remainingQuantity: 0,
			protectedAssignments: []
		});
	});

	it('selects only the packed excess copy for the return task', () => {
		const plans = planSyncRemovals(
			[cards[0]],
			[
				{
					id: 100,
					deckCardId: 10,
					status: 'assigned',
					pulled: true,
					collectionId: 5
				},
				{
					id: 101,
					deckCardId: 10,
					status: 'assigned',
					pulled: true,
					collectionId: 6
				}
			],
			[{ cardName: 'Counterspell', board: 'main', quantity: 1 }]
		);
		expect(plans[0].protectedAssignments.map((assignment) => assignment.id)).toEqual([100]);
		expect(plans[0]).toMatchObject({
			targetQuantity: 1,
			remainingQuantity: 2
		});
	});

	it('blocks a basic-land reduction when the hand-count slot is packed', () => {
		const conflicts = findSyncRemovalConflicts(
			[cards[1]],
			[
				{
					id: 200,
					deckCardId: 20,
					status: 'unassigned',
					pulled: true,
					collectionId: null
				},
				{
					id: 201,
					deckCardId: 20,
					status: 'unassigned',
					pulled: false,
					collectionId: null
				}
			],
			[]
		);
		expect(conflicts.find((conflict) => conflict.cardName === 'Island')).toMatchObject({
			requestedRemoval: 2,
			removableCount: 1
		});
	});

	it('permits quantity reductions when enough unassigned slots exist', () => {
		const conflicts = findSyncRemovalConflicts(
			[cards[1]],
			[
				{
					id: 200,
					deckCardId: 20,
					status: 'assigned',
					pulled: true,
					collectionId: 9
				},
				{
					id: 201,
					deckCardId: 20,
					status: 'unassigned',
					pulled: false,
					collectionId: null
				}
			],
			[{ cardName: 'Island', board: 'main', quantity: 1 }]
		);
		expect(conflicts).toEqual([]);
	});

	it('removes safe copies and retains only the protected excess as pending', () => {
		const plans = planSyncRemovals(
			[cards[1]],
			[
				{
					id: 200,
					deckCardId: 20,
					status: 'assigned',
					pulled: true,
					collectionId: 9
				},
				{
					id: 201,
					deckCardId: 20,
					status: 'unassigned',
					pulled: false,
					collectionId: null
				}
			],
			[]
		);
		expect(plans).toEqual([
			{
				deckCardId: 20,
				cardName: 'Island',
				board: 'main',
				requestedRemoval: 2,
				targetQuantity: 0,
				removableCount: 1,
				removeIds: [201],
				remainingQuantity: 1,
				protectedAssignments: [
					{
						id: 200,
						deckCardId: 20,
						status: 'assigned',
						pulled: true,
						collectionId: 9
					}
				]
			}
		]);
	});

	it('clears the reduction plan when Moxfield catches up to local quantity', () => {
		const plans = planSyncRemovals(
			[cards[0]],
			[
				{
					id: 100,
					deckCardId: 10,
					status: 'assigned',
					pulled: false,
					collectionId: 5
				}
			],
			[{ cardName: 'Counterspell', board: 'main', quantity: 1 }]
		);
		expect(plans).toEqual([]);
	});
});

describe('pending-removal resolution order', () => {
	it('uses unassigned copies before assigned copies and packed copies last', () => {
		expect(
			selectAssignmentsForPendingRemoval(
				[
					{ id: 1, status: 'assigned', pulled: true, collectionId: 10 },
					{ id: 4, status: 'assigned', pulled: false, collectionId: 11 },
					{ id: 3, status: 'unassigned', pulled: false, collectionId: null },
					{ id: 2, status: 'proxied', pulled: false, collectionId: null }
				],
				3
			)
		).toEqual([3, 4, 2]);
	});

	it('returns only the requested number of assignment IDs', () => {
		expect(
			selectAssignmentsForPendingRemoval(
				[
					{ id: 1, status: 'assigned', pulled: false, collectionId: 10 },
					{ id: 2, status: 'assigned', pulled: false, collectionId: 11 }
				],
				1
			)
		).toEqual([2]);
	});
});
