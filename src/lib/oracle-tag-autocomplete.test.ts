import { describe, expect, it } from 'vitest';
import { findActiveOracleTagToken, replaceActiveOracleTagToken } from './oracle-tag-autocomplete';

describe('Oracle tag autocomplete token helpers', () => {
	it('finds unquoted and quoted partial tag tokens', () => {
		expect(findActiveOracleTagToken('c:W otag:lif', 12)).toMatchObject({
			prefix: 'otag:',
			query: 'lif'
		});
		expect(findActiveOracleTagToken('oracle-tag:"card dr', 19)).toMatchObject({
			prefix: 'oracle-tag:',
			query: 'card dr'
		});
	});

	it('preserves negation', () => {
		expect(findActiveOracleTagToken('-otag:burn', 10)).toMatchObject({
			prefix: '-otag:',
			query: 'burn'
		});
	});

	it('ignores completed quoted tags and unrelated text', () => {
		expect(findActiveOracleTagToken('otag:"Card Draw"', 16)).toBeNull();
		expect(findActiveOracleTagToken('card draw', 9)).toBeNull();
	});

	it('replaces only the active token and quotes the selected label', () => {
		const value = 'c:U otag:draw sort:name';
		const active = findActiveOracleTagToken(value, 13);
		expect(active).not.toBeNull();
		expect(replaceActiveOracleTagToken(value, active!, 'Card Draw')).toEqual({
			value: 'c:U otag:"Card Draw" sort:name',
			cursor: 20
		});
	});
});
