export type ScryfallCompatibilityCase = {
	name: string;
	query: string;
	expectedIds: string[];
	sharedOracleTags?: Map<string, Set<string>>;
};

export const SCRYFALL_QUERY_CORPUS: ScryfallCompatibilityCase[] = [
	{
		name: 'nested Oracle-text alternatives with identity, permanent types, and exclusion',
		query:
			'id:uw (o:"tap target" or o:"tap an untapped") ' +
			'(t:creature or t:artifact or t:enchantment) -t:planeswalker',
		expectedIds: ['tap-artifact', 'tap-creature']
	},
	{
		name: 'format legality, grouped card types, and a printing predicate',
		query: 'f:commander (t:instant OR t:sorcery) -is:promo',
		expectedIds: ['r1']
	},
	{
		name: 'color subset, grouped permanent types, and mana-value comparison',
		query: 'c<=wu (t:creature OR t:artifact) mv<=2',
		expectedIds: ['cl1', 'tap-artifact', 'tap-creature', 'tap-wrong-identity', 'w1']
	},
	{
		name: 'not alias composed with a grouped has/is expression',
		query: 'not:reprint (has:watermark OR is:commander)',
		expectedIds: ['u1', 'w1', 'wu1']
	},
	{
		name: 'exact name composed with Oracle regex and a negated type',
		query: '!"Sol Ring" OR (o:/tap (target|an untapped)/ -t:planeswalker)',
		expectedIds: ['cl1', 'tap-artifact', 'tap-creature', 'tap-wrong-identity']
	},
	{
		name: 'quoted Oracle tag composed with an identity group',
		query: 'otag:"Life Gain" (id:w OR id:wu)',
		expectedIds: ['w1', 'wu1'],
		sharedOracleTags: new Map([['life gain', new Set(['ow', 'owu'])]])
	}
];
