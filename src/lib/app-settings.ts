/** Thin localStorage wrappers for app-level preferences. */

export type ManagerGroupMode = 'deck' | 'type' | 'color';

const MANAGER_GROUP_MODES = new Set<ManagerGroupMode>(['deck', 'type', 'color']);

export function getIgnoreBasics(): boolean {
	if (typeof localStorage === 'undefined') return false;
	return localStorage.getItem('ignoreBasics') === '1';
}

export function setIgnoreBasics(v: boolean): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem('ignoreBasics', v ? '1' : '0');
}

export function getIgnoreMaybeboard(): boolean {
	if (typeof localStorage === 'undefined') return true; // default ON
	const stored = localStorage.getItem('ignoreMaybeboard');
	if (stored === null) return true; // default ON when not set
	return stored !== '0';
}

export function setIgnoreMaybeboard(v: boolean): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem('ignoreMaybeboard', v ? '1' : '0');
}

export function getManagerGroupMode(): ManagerGroupMode {
	if (typeof localStorage === 'undefined') return 'type';
	const stored = localStorage.getItem('managerGroupMode');
	return MANAGER_GROUP_MODES.has(stored as ManagerGroupMode)
		? (stored as ManagerGroupMode)
		: 'type';
}

export function setManagerGroupMode(mode: ManagerGroupMode): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem('managerGroupMode', mode);
}
