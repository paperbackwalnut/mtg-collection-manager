import { describe, expect, it } from 'vitest';
import { isWritableAssignmentStatus } from './assignment-status';

describe('writable assignment statuses', () => {
	it.each(['unassigned', 'needed', 'ordered', 'assigned', 'proxied'])(
		'accepts supported status %s',
		(status) => expect(isWritableAssignmentStatus(status)).toBe(true)
	);

	it.each(['pulled', 'removed-status', '', 'unknown'])('rejects unsupported status %s', (status) =>
		expect(isWritableAssignmentStatus(status)).toBe(false)
	);
});
