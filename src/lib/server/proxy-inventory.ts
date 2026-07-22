export type ProxyPrintState = 'ready' | 'needs_reprint';
export type ProxyInventoryAssignmentState = 'available' | 'reserved' | 'in_deck';
export const PROXY_PRINT_STATES = ['ready', 'needs_reprint'] as const;

export type LegacyProxyAssignment = {
	status: string;
	printStatus: string | null;
};

export type ProxyReservationCandidate = {
	cardName: string;
	status: string;
	proxyInventoryId: number | null;
};

export function legacyProxyPrintState(assignment: LegacyProxyAssignment): ProxyPrintState | null {
	if (assignment.status !== 'proxied') return null;
	if (assignment.printStatus === 'need_print') return null;
	return assignment.printStatus === 'need_reprint' ? 'needs_reprint' : 'ready';
}

export function proxyInventoryAssignmentState(
	assignmentId: number | null,
	pulled: boolean | null
): ProxyInventoryAssignmentState {
	if (assignmentId === null) return 'available';
	return pulled ? 'in_deck' : 'reserved';
}

export function proxyReservationError(
	inventoryCardName: string,
	assignment: ProxyReservationCandidate
): string | null {
	if (assignment.status !== 'proxied') return 'Only proxy assignments can reserve printed proxies';
	if (assignment.proxyInventoryId !== null) return 'That assignment already has a printed proxy';
	if (assignment.cardName.toLocaleLowerCase() !== inventoryCardName.toLocaleLowerCase()) {
		return 'The printed proxy and deck assignment must be the same card';
	}
	return null;
}

export function proxyReleaseError(pulled: boolean): string | null {
	return pulled ? 'Unpack this proxy from its deck before releasing it' : null;
}

export function proxyInventoryDetailsError(input: {
	setCode: string | null;
	collectorNumber: string | null;
	printState: string;
}): string | null {
	if (!PROXY_PRINT_STATES.includes(input.printState as ProxyPrintState)) {
		return 'Invalid proxy print state';
	}
	if ((input.setCode === null) !== (input.collectorNumber === null)) {
		return 'Set code and collector number must be provided together';
	}
	return null;
}

export function nextProxyPrintStatus(input: {
	currentStatus: string;
	currentPrintStatus: string | null;
	hasInventory: boolean;
	nextStatus: string;
	requestedPrintStatus?: string | null;
}): string | null {
	if (input.nextStatus !== 'proxied') return null;
	if (input.requestedPrintStatus !== undefined) {
		if (!input.requestedPrintStatus && !input.hasInventory) return 'need_print';
		return input.requestedPrintStatus || null;
	}
	if (input.currentStatus !== 'proxied' && !input.hasInventory) return 'need_print';
	return input.currentPrintStatus;
}
