export type RemovableAssignment = {
	id: number;
	status: string;
	pulled: boolean;
	collectionId: number | null;
};

export type AssignmentRemovalPlan = {
	removeIds: number[];
	protectedAssignments: RemovableAssignment[];
};

export function canRemoveAssignment(assignment: RemovableAssignment): boolean {
	return (
		assignment.status === 'unassigned' && !assignment.pulled && assignment.collectionId === null
	);
}

export function planAssignmentReduction(
	assignments: RemovableAssignment[],
	removeCount: number
): AssignmentRemovalPlan {
	if (removeCount <= 0) return { removeIds: [], protectedAssignments: [] };

	const removable = assignments.filter(canRemoveAssignment).sort((a, b) => a.id - b.id);
	const removeIds = removable.slice(0, removeCount).map((assignment) => assignment.id);

	if (removeIds.length === removeCount) {
		return { removeIds, protectedAssignments: [] };
	}

	const removableIds = new Set(removeIds);
	return {
		removeIds,
		protectedAssignments: assignments.filter(
			(assignment) => !removableIds.has(assignment.id) && !canRemoveAssignment(assignment)
		)
	};
}

export function selectAssignmentsForPendingRemoval(
	assignments: RemovableAssignment[],
	removeCount: number
): number[] {
	return [...assignments]
		.sort((left, right) => {
			const leftSafe = canRemoveAssignment(left) ? 0 : 1;
			const rightSafe = canRemoveAssignment(right) ? 0 : 1;
			if (leftSafe !== rightSafe) return leftSafe - rightSafe;
			if (left.pulled !== right.pulled) return left.pulled ? 1 : -1;
			return right.id - left.id;
		})
		.slice(0, Math.max(0, removeCount))
		.map((assignment) => assignment.id);
}
