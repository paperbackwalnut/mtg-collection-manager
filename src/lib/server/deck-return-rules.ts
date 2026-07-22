export type PendingRemovalRequest = {
	deckId: number;
	pendingRemovalId: number;
};

export type ReturnAssignment = {
	id: number;
	status: string;
	collectionId: number | null;
};

export class PendingRemovalError extends Error {
	constructor(
		message: string,
		public readonly code: 'not_found' | 'stale'
	) {
		super(message);
		this.name = 'PendingRemovalError';
	}
}

export function normalizePendingRemovalRequests(
	requests: PendingRemovalRequest[]
): PendingRemovalRequest[] {
	const byPendingId = new Map<number, PendingRemovalRequest>();
	for (const request of requests) {
		if (
			!Number.isInteger(request.deckId) ||
			request.deckId <= 0 ||
			!Number.isInteger(request.pendingRemovalId) ||
			request.pendingRemovalId <= 0
		) {
			throw new PendingRemovalError('Invalid return task.', 'not_found');
		}
		const existing = byPendingId.get(request.pendingRemovalId);
		if (existing && existing.deckId !== request.deckId) {
			throw new PendingRemovalError('Conflicting return task.', 'stale');
		}
		byPendingId.set(request.pendingRemovalId, request);
	}
	return [...byPendingId.values()].sort(
		(left, right) => left.deckId - right.deckId || left.pendingRemovalId - right.pendingRemovalId
	);
}

export function ownedCollectionIdsForReturn(
	assignments: ReturnAssignment[],
	removeIds: number[]
): number[] {
	const removed = new Set(removeIds);
	return [
		...new Set(
			assignments
				.filter(
					(assignment) =>
						removed.has(assignment.id) &&
						assignment.status === 'assigned' &&
						assignment.collectionId !== null
				)
				.map((assignment) => assignment.collectionId as number)
		)
	];
}
