import { describe, expect, it } from 'vitest';
import { getColorKey, getTypeKey } from './bucket-config';
import { isLandOnlyTypeLine } from './card-classification';
import { computeLocation, getCardColors, getTypeOrder } from './server/location';

describe('Pick List card classification', () => {
	it('keeps a green creature/land MDFC in green creature grouping', () => {
		const typeLine = 'Creature — Elemental // Land';
		const colors = [...getCardColors('["G"]', null)].join('');

		expect(isLandOnlyTypeLine(typeLine)).toBe(false);
		expect(computeLocation(typeLine, null, 1, null, 10, '["G"]')).toBe('box_g');
		expect(getColorKey(colors, typeLine)).toBe('G');
		expect(getTypeKey(typeLine)).toBe('Creature');
	});

	it('keeps land-only single- and double-faced cards in land grouping', () => {
		for (const typeLine of ['Land', 'Basic Land — Plains', 'Land // Land']) {
			expect(isLandOnlyTypeLine(typeLine)).toBe(true);
			expect(computeLocation(typeLine, null, 1, null)).toBe('box_land');
			expect(getColorKey('', typeLine)).toBe('land');
		}
	});

	it('groups artifact creatures as creatures', () => {
		const typeLine = 'Artifact Creature — Construct';

		expect(getTypeKey(typeLine)).toBe('Creature');
		expect(getTypeOrder(typeLine)).toBe(0);
	});

	it('prefers cached color identity and falls back only when unavailable', () => {
		expect([...getCardColors('["G"]', '{2}{R}')]).toEqual(['G']);
		expect([...getCardColors('[]', '{2}{R}')]).toEqual([]);
		expect([...getCardColors(null, '{2}{R}')]).toEqual(['R']);
	});
});
