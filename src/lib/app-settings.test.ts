import { afterEach, describe, expect, it, vi } from 'vitest';
import { getManagerGroupMode, setManagerGroupMode, type ManagerGroupMode } from './app-settings';

function stubStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value)
	});
	return values;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('Manager group mode preference', () => {
	it('defaults to type when no preference is stored', () => {
		stubStorage();
		expect(getManagerGroupMode()).toBe('type');
	});

	it.each<ManagerGroupMode>(['deck', 'type', 'color'])('restores %s', (mode) => {
		stubStorage({ managerGroupMode: mode });
		expect(getManagerGroupMode()).toBe(mode);
	});

	it('rejects an unknown stored value', () => {
		stubStorage({ managerGroupMode: 'rarity' });
		expect(getManagerGroupMode()).toBe('type');
	});

	it('stores an explicit selection', () => {
		const values = stubStorage();
		setManagerGroupMode('color');
		expect(values.get('managerGroupMode')).toBe('color');
	});
});
