export const WRITABLE_ASSIGNMENT_STATUSES = [
	'unassigned',
	'needed',
	'ordered',
	'assigned',
	'proxied'
] as const;

export type WritableAssignmentStatus = (typeof WRITABLE_ASSIGNMENT_STATUSES)[number];

export function isWritableAssignmentStatus(value: string): value is WritableAssignmentStatus {
	return WRITABLE_ASSIGNMENT_STATUSES.includes(value as WritableAssignmentStatus);
}
