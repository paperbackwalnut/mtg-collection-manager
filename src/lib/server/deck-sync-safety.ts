import { canRemoveAssignment, type RemovableAssignment } from './deck-mutation-rules';

export type CurrentDeckCard = {
	id: number;
	cardName: string;
	board: string | null;
};

export type IncomingDeckCard = {
	cardName: string;
	board: string;
	quantity: number;
};

export type SyncAssignment = RemovableAssignment & {
	deckCardId: number;
};

export type SyncRemovalConflict = {
	deckCardId: number;
	cardName: string;
	board: string;
	requestedRemoval: number;
	removableCount: number;
	protectedAssignments: RemovableAssignment[];
};

export type SyncRemovalPlan = SyncRemovalConflict & {
	targetQuantity: number;
	removeIds: number[];
	remainingQuantity: number;
};

function planSyncAssignmentReduction(
	assignments: RemovableAssignment[],
	removeCount: number
): { removeIds: number[]; protectedAssignments: RemovableAssignment[] } {
	if (removeCount <= 0) return { removeIds: [], protectedAssignments: [] };

	const ordered = [...assignments].sort((left, right) => {
		if (left.pulled !== right.pulled) return left.pulled ? 1 : -1;
		const leftUnassigned = canRemoveAssignment(left) ? 0 : 1;
		const rightUnassigned = canRemoveAssignment(right) ? 0 : 1;
		if (leftUnassigned !== rightUnassigned) return leftUnassigned - rightUnassigned;
		return left.id - right.id;
	});
	const selected = ordered.slice(0, removeCount);

	return {
		removeIds: selected
			.filter((assignment) => !assignment.pulled)
			.map((assignment) => assignment.id),
		protectedAssignments: selected.filter((assignment) => assignment.pulled)
	};
}

export function planSyncRemovals(
	currentCards: CurrentDeckCard[],
	assignments: SyncAssignment[],
	incomingCards: IncomingDeckCard[]
): SyncRemovalPlan[] {
	const assignmentsByDeckCard = new Map<number, SyncAssignment[]>();
	for (const assignment of assignments) {
		const rows = assignmentsByDeckCard.get(assignment.deckCardId) ?? [];
		rows.push(assignment);
		assignmentsByDeckCard.set(assignment.deckCardId, rows);
	}

	const oldByNameBoard = new Map(
		currentCards.map((card) => [`${card.cardName}:::${card.board ?? 'main'}`, card])
	);
	const oldByName = new Map(currentCards.map((card) => [card.cardName, card]));
	const matchedOldIds = new Set<number>();
	const reductions = new Map<number, { requestedRemoval: number; targetQuantity: number }>();

	for (const incoming of incomingCards) {
		const exactKey = `${incoming.cardName}:::${incoming.board}`;
		let current = oldByNameBoard.get(exactKey);
		if (!current) {
			const sameName = oldByName.get(incoming.cardName);
			if (sameName && !matchedOldIds.has(sameName.id)) current = sameName;
		}
		if (!current) continue;

		matchedOldIds.add(current.id);
		const currentQuantity = assignmentsByDeckCard.get(current.id)?.length ?? 0;
		if (incoming.quantity < currentQuantity) {
			reductions.set(current.id, {
				requestedRemoval: currentQuantity - incoming.quantity,
				targetQuantity: incoming.quantity
			});
		}
	}

	for (const card of currentCards) {
		if (!matchedOldIds.has(card.id)) {
			const currentQuantity = assignmentsByDeckCard.get(card.id)?.length ?? 0;
			reductions.set(card.id, {
				requestedRemoval: currentQuantity,
				targetQuantity: 0
			});
		}
	}

	const plans: SyncRemovalPlan[] = [];
	for (const [deckCardId, reduction] of reductions) {
		const { requestedRemoval, targetQuantity } = reduction;
		if (requestedRemoval <= 0) continue;
		const card = currentCards.find((candidate) => candidate.id === deckCardId);
		if (!card) continue;
		const cardAssignments = assignmentsByDeckCard.get(deckCardId) ?? [];
		const plan = planSyncAssignmentReduction(cardAssignments, requestedRemoval);
		plans.push({
			deckCardId,
			cardName: card.cardName,
			board: card.board ?? 'main',
			requestedRemoval,
			targetQuantity,
			removableCount: plan.removeIds.length,
			removeIds: plan.removeIds,
			remainingQuantity: cardAssignments.length - plan.removeIds.length,
			protectedAssignments: plan.protectedAssignments
		});
	}

	return plans;
}

export function findSyncRemovalConflicts(
	currentCards: CurrentDeckCard[],
	assignments: SyncAssignment[],
	incomingCards: IncomingDeckCard[]
): SyncRemovalConflict[] {
	return planSyncRemovals(currentCards, assignments, incomingCards).filter(
		(plan) => plan.remainingQuantity > plan.targetQuantity
	);
}
