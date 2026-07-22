/**
 * Tests for scryfall-search.ts — pure parser + executor.
 * Uses temp databases populated inline — no production data dependency.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { parseScryfallSearch, executeSearch, CacheNotReadyError } from '../scryfall-search';
import { buildNameConditions, applySortToEntries } from '../collection-filters';
import { mapToRow } from '../scryfall';
import { openDb } from '../db/scryfall-sqlite';
import { SCRYFALL_QUERY_CORPUS } from './fixtures/scryfall-query-corpus';

// ── Temp DB helpers ───────────────────────────────────────────────────────────

function tempDbPath(): string {
	return path.join(os.tmpdir(), `ss-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
function removeTempDb(p: string) {
	try {
		fs.unlinkSync(p);
	} catch {
		/* */
	}
}

type CardSeed = {
	id: string;
	name: string;
	set_code?: string;
	collector_number?: string;
	type_line?: string;
	mana_cost?: string;
	cmc?: number;
	oracle_text?: string;
	oracle_id?: string | null;
	price_usd?: number | null;
	price_usd_foil?: number | null;
	colors?: string | null;
	color_identity?: string | null;
	rarity?: string | null;
	edhrec_rank?: number | null;
	legalities?: string | null;
	power?: string | null;
	toughness?: string | null;
	loyalty?: string | null;
	keywords?: string | null;
	produced_mana?: string | null;
	artist?: string | null;
	flavor_text?: string | null;
	watermark?: string | null;
	released_at?: string | null;
	printing_metadata?: string | null;
};

function seedCard(d: Database.Database, card: CardSeed): void {
	d.prepare(
		`
		INSERT OR REPLACE INTO scryfall_cache
		(id, name, set_code, collector_number, type_line, mana_cost, cmc,
		 oracle_text, oracle_id, price_usd, price_usd_foil, colors, color_identity,
		 rarity, edhrec_rank, legalities, power, toughness, loyalty, keywords,
		 produced_mana, artist, flavor_text, watermark, released_at,
		 printing_metadata,
		 image_uri, back_image_uri, last_updated)
		VALUES
		(@id, @name, @set_code, @collector_number, @type_line, @mana_cost, @cmc,
		 @oracle_text, @oracle_id, @price_usd, @price_usd_foil, @colors, @color_identity,
		 @rarity, @edhrec_rank, @legalities, @power, @toughness, @loyalty, @keywords,
		 @produced_mana, @artist, @flavor_text, @watermark, @released_at,
		 @printing_metadata,
		 NULL, NULL, 1000)
	`
	).run({
		set_code: 'tst',
		collector_number: '1',
		type_line: '',
		mana_cost: '',
		cmc: 0,
		oracle_text: null,
		oracle_id: null,
		price_usd: null,
		price_usd_foil: null,
		colors: null,
		color_identity: null,
		rarity: null,
		edhrec_rank: null,
		legalities: null,
		power: null,
		toughness: null,
		loyalty: null,
		keywords: null,
		produced_mana: null,
		artist: null,
		flavor_text: null,
		watermark: null,
		released_at: null,
		printing_metadata: null,
		...card
	});
}

function printingMetadata(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		lang: 'en',
		games: ['paper'],
		finishes: ['nonfoil'],
		frame: '2015',
		frameEffects: [],
		layout: 'normal',
		setName: 'Test Set',
		setType: 'expansion',
		promo: false,
		promoTypes: [],
		reprint: false,
		reserved: false,
		digital: false,
		fullArt: false,
		textless: false,
		oversized: false,
		variation: false,
		highresImage: true,
		securityStamp: null,
		borderColor: 'black',
		booster: true,
		storySpotlight: false,
		printedName: null,
		gameChanger: false,
		colorIndicator: [],
		previewSource: null,
		...overrides
	});
}

// ── Parser tests ──────────────────────────────────────────────────────────────

describe('parseScryfallSearch — pure, no DB', () => {
	it('empty input → empty AST', () => {
		const ast = parseScryfallSearch('');
		expect(ast.nameTerms).toEqual([]);
		expect(ast.filters).toEqual([]);
		expect(ast.errors).toEqual([]);
		expect(ast.sort).toBe('name');
		expect(ast.direction).toBe('asc');
	});

	// ── Bare text ──────────────────────────────────────────────────────────────

	it('bare words become separate nameTerms', () => {
		const ast = parseScryfallSearch('lightning bolt');
		expect(ast.nameTerms).toEqual([
			{ value: 'lightning', negate: false },
			{ value: 'bolt', negate: false }
		]);
		expect(ast.filters).toEqual([]);
	});

	it('multiple bare words in any order each become a nameTerm (AND semantics support)', () => {
		const ast = parseScryfallSearch('Ring Sol');
		expect(ast.nameTerms).toHaveLength(2);
		expect(ast.nameTerms.map((t) => t.value)).toContain('Ring');
		expect(ast.nameTerms.map((t) => t.value)).toContain('Sol');
	});

	it('quoted bare phrase becomes a single nameTerm', () => {
		const ast = parseScryfallSearch('"Sol Ring"');
		expect(ast.nameTerms).toEqual([{ value: 'Sol Ring', negate: false }]);
	});

	it('parses OR with Scryfall precedence and marks it for local execution', () => {
		const ast = parseScryfallSearch('t:creature OR (t:artifact mv<=2)');
		expect(ast.errors).toEqual([]);
		expect(ast.expression?.kind).toBe('or');
		expect(ast.requiresExecutor).toBe(true);
		expect(ast.useDatabaseNameTerms).toBe(false);
	});

	it('parses exact-name syntax', () => {
		const ast = parseScryfallSearch('!"Sol Ring"');
		expect(ast.errors).toEqual([]);
		expect(ast.expression).toEqual({
			kind: 'term',
			filter: { kind: 'name', value: 'Sol Ring', mode: 'exact', negate: false }
		});
		expect(ast.requiresExecutor).toBe(true);
	});

	it('parses bare and field regular expressions', () => {
		const bare = parseScryfallSearch('/^Sol Ring$/');
		const oracle = parseScryfallSearch('o:/draw (a|two) cards?/');
		expect(bare.errors).toEqual([]);
		expect(oracle.errors).toEqual([]);
		expect(bare.requiresExecutor).toBe(true);
		expect(oracle.filters).toContainEqual({
			kind: 'oracle',
			value: 'draw (a|two) cards?',
			mode: 'regex',
			negate: false
		});
	});

	it('reports malformed boolean and grouping syntax', () => {
		expect(parseScryfallSearch('(t:creature').errors).not.toEqual([]);
		expect(parseScryfallSearch('t:creature OR').errors).not.toEqual([]);
		expect(parseScryfallSearch('o:/[invalid/').errors).not.toEqual([]);
	});

	// ── name: and n: ───────────────────────────────────────────────────────────

	it('name: becomes a nameTerm', () => {
		const ast = parseScryfallSearch('name:lightning');
		expect(ast.nameTerms).toEqual([{ value: 'lightning', negate: false }]);
		expect(ast.filters).toEqual([]);
	});

	it('n: alias', () => {
		const ast = parseScryfallSearch('n:bolt');
		expect(ast.nameTerms).toEqual([{ value: 'bolt', negate: false }]);
	});

	it('-name:Sol is a negative nameTerm', () => {
		const ast = parseScryfallSearch('-name:Sol');
		expect(ast.nameTerms).toEqual([{ value: 'Sol', negate: true }]);
	});

	it('-n:Sol is a negative nameTerm', () => {
		const ast = parseScryfallSearch('-n:Sol');
		expect(ast.nameTerms).toEqual([{ value: 'Sol', negate: true }]);
	});

	it('name= is accepted (= treated like :)', () => {
		const ast = parseScryfallSearch('name=lightning');
		expect(ast.nameTerms).toEqual([{ value: 'lightning', negate: false }]);
		expect(ast.errors).toEqual([]);
	});

	it('name>3 is an operator error', () => {
		const ast = parseScryfallSearch('name>3');
		expect(ast.errors).toHaveLength(1);
		expect(ast.errors[0].message).toMatch(/operator/i);
	});

	// ── t:/type: ──────────────────────────────────────────────────────────────

	it('t: and type: aliases', () => {
		expect(parseScryfallSearch('t:creature').filters).toContainEqual({
			kind: 'type',
			value: 'creature',
			negate: false
		});
		expect(parseScryfallSearch('type:instant').filters).toContainEqual({
			kind: 'type',
			value: 'instant',
			negate: false
		});
	});

	it('t= is accepted', () => {
		const ast = parseScryfallSearch('t=creature');
		expect(ast.errors).toEqual([]);
		expect(ast.filters).toContainEqual({ kind: 'type', value: 'creature', negate: false });
	});

	it('t>= is an invalid operator for type', () => {
		const ast = parseScryfallSearch('t>=creature');
		expect(ast.errors).toHaveLength(1);
		expect(ast.errors[0].message).toMatch(/operator/i);
	});

	it('invalid type token does not become a bare name term', () => {
		const ast = parseScryfallSearch('t>=creature');
		expect(ast.nameTerms).toEqual([]);
	});

	// ── o:/oracle: ────────────────────────────────────────────────────────────

	it('o: and oracle: aliases', () => {
		expect(parseScryfallSearch('o:flying').filters).toContainEqual({
			kind: 'oracle',
			value: 'flying',
			negate: false
		});
		expect(parseScryfallSearch('oracle:draw').filters).toContainEqual({
			kind: 'oracle',
			value: 'draw',
			negate: false
		});
	});

	it('o>draw is an invalid operator for oracle', () => {
		const ast = parseScryfallSearch('o>draw');
		expect(ast.errors).toHaveLength(1);
		expect(ast.errors[0].message).toMatch(/operator/i);
		expect(ast.nameTerms).toEqual([]);
	});

	// ── otag:/oracle-tag: ────────────────────────────────────────────────────

	it('parses quoted Oracle tags and the oracle-tag alias', () => {
		expect(parseScryfallSearch('otag:"Life Gain"').filters).toContainEqual({
			kind: 'oracleTag',
			value: 'Life Gain',
			negate: false
		});
		expect(parseScryfallSearch('oracle-tag:draw').filters).toContainEqual({
			kind: 'oracleTag',
			value: 'draw',
			negate: false
		});
		expect(parseScryfallSearch('function:ramp').filters).toContainEqual({
			kind: 'oracleTag',
			value: 'ramp',
			negate: false
		});
		expect(parseScryfallSearch('oracletag:draw').filters).toContainEqual({
			kind: 'oracleTag',
			value: 'draw',
			negate: false
		});
	});

	it('parses price and format-legality operators', () => {
		expect(parseScryfallSearch('usd<=2').filters).toContainEqual({
			kind: 'price',
			op: '<=',
			val: 2,
			negate: false
		});
		expect(parseScryfallSearch('f:commander').filters).toContainEqual({
			kind: 'legality',
			format: 'commander',
			status: 'legal',
			negate: false
		});
		expect(parseScryfallSearch('banned:modern').filters).toContainEqual({
			kind: 'legality',
			format: 'modern',
			status: 'banned',
			negate: false
		});
	});

	it('parses gameplay, attribution, and release-date fields', () => {
		expect(parseScryfallSearch('pow>=3').filters).toContainEqual({
			kind: 'stat',
			field: 'power',
			op: '>=',
			value: '3',
			negate: false
		});
		expect(parseScryfallSearch('tou:*').filters).toContainEqual({
			kind: 'stat',
			field: 'toughness',
			op: '=',
			value: '*',
			negate: false
		});
		expect(parseScryfallSearch('kw:\"First strike\"').filters).toContainEqual({
			kind: 'keyword',
			value: 'First strike',
			negate: false
		});
		expect(parseScryfallSearch('produces:WU').filters).toContainEqual({
			kind: 'produces',
			chars: ['W', 'U'],
			negate: false
		});
		expect(parseScryfallSearch('a:\"Mark Poole\"').filters).toContainEqual({
			kind: 'textMetadata',
			field: 'artist',
			value: 'Mark Poole',
			negate: false
		});
		expect(parseScryfallSearch('date>=2020-01').filters).toContainEqual({
			kind: 'date',
			field: 'released_at',
			op: '>=',
			value: '2020-01',
			negate: false
		});
		expect(parseScryfallSearch('year:1997').filters).toContainEqual({
			kind: 'date',
			field: 'year',
			op: '=',
			value: '1997',
			negate: false
		});
	});

	it('validates stat comparisons and release dates', () => {
		expect(parseScryfallSearch('pow>star').errors).not.toEqual([]);
		expect(parseScryfallSearch('year:97').errors).not.toEqual([]);
		expect(parseScryfallSearch('date:July').errors).not.toEqual([]);
	});

	it('parses printing metadata and in: aliases', () => {
		expect(parseScryfallSearch('lang:japanese').filters).toContainEqual({
			kind: 'printingMetadata',
			field: 'lang',
			value: 'ja',
			negate: false
		});
		expect(parseScryfallSearch('game:arena').filters).toContainEqual({
			kind: 'printingMetadata',
			field: 'game',
			value: 'arena',
			negate: false
		});
		expect(parseScryfallSearch('finish:regular').filters).toContainEqual({
			kind: 'printingMetadata',
			field: 'finish',
			value: 'nonfoil',
			negate: false
		});
		expect(parseScryfallSearch('frame:1997 layout:transform st:core').filters).toEqual(
			expect.arrayContaining([
				{ kind: 'printingMetadata', field: 'frame', value: '1997', negate: false },
				{ kind: 'printingMetadata', field: 'layout', value: 'transform', negate: false },
				{ kind: 'printingMetadata', field: 'setType', value: 'core', negate: false }
			])
		);
		expect(parseScryfallSearch('border:borderless stamp:oval').filters).toEqual(
			expect.arrayContaining([
				{ kind: 'printingMetadata', field: 'borderColor', value: 'borderless', negate: false },
				{ kind: 'printingMetadata', field: 'securityStamp', value: 'oval', negate: false }
			])
		);
		expect(parseScryfallSearch('in:\"Return to Ravnica\"').filters).toContainEqual({
			kind: 'in',
			value: 'return to ravnica',
			negate: false
		});
	});

	it('rejects unknown games, finishes, and frames', () => {
		expect(parseScryfallSearch('game:xbox').errors).not.toEqual([]);
		expect(parseScryfallSearch('finish:matte').errors).not.toEqual([]);
		expect(parseScryfallSearch('frame:modern').errors).not.toEqual([]);
	});

	it('parses and validates is:, not:, and has: predicates', () => {
		expect(parseScryfallSearch('is:commander').filters).toContainEqual({
			kind: 'is',
			value: 'commander',
			negate: false
		});
		expect(parseScryfallSearch('not:reprint').filters).toContainEqual({
			kind: 'is',
			value: 'reprint',
			negate: true
		});
		expect(parseScryfallSearch('-not:reprint').filters).toContainEqual({
			kind: 'is',
			value: 'reprint',
			negate: false
		});
		expect(parseScryfallSearch('is:fullart is:brawlcommander').filters).toEqual(
			expect.arrayContaining([
				{ kind: 'is', value: 'full', negate: false },
				{ kind: 'is', value: 'brawler', negate: false }
			])
		);
		expect(parseScryfallSearch('has:indicator has:power-and-toughness').filters).toEqual(
			expect.arrayContaining([
				{ kind: 'has', value: 'indicator', negate: false },
				{ kind: 'has', value: 'pt', negate: false }
			])
		);
		expect(parseScryfallSearch('is:fetchland').errors).not.toEqual([]);
		expect(parseScryfallSearch('has:unknown').errors).not.toEqual([]);
	});

	it('accepts every implemented is: and has: property', () => {
		const isValues = [
			'commander',
			'brawler',
			'oathbreaker',
			'duelcommander',
			'companion',
			'gamechanger',
			'reserved',
			'hybrid',
			'phyrexian',
			'split',
			'flip',
			'transform',
			'meld',
			'leveler',
			'dfc',
			'mdfc',
			'spell',
			'permanent',
			'historic',
			'party',
			'modal',
			'vanilla',
			'frenchvanilla',
			'funny',
			'booster',
			'planeswalker_deck',
			'league',
			'buyabox',
			'giftbox',
			'intro_pack',
			'gameday',
			'prerelease',
			'release',
			'datestamped',
			'full',
			'nonfoil',
			'foil',
			'etched',
			'glossy',
			'hires',
			'new',
			'old',
			'digital',
			'promo',
			'spotlight',
			'scryfallpreview',
			'reprint',
			'unique',
			'masterpiece',
			'colorshifted',
			'oversized',
			'textless',
			'variation',
			'borderless',
			'boosterfun',
			'showcase',
			'extendedart',
			'alchemy',
			'universesbeyond'
		];
		const hasValues = [
			'indicator',
			'watermark',
			'foil',
			'nonfoil',
			'promo',
			'colors',
			'flavor',
			'oracle',
			'loyalty',
			'pt',
			'multifaced',
			'securitystamp',
			'artist',
			'mana'
		];
		for (const value of isValues) {
			expect(parseScryfallSearch(`is:${value}`).errors, value).toEqual([]);
		}
		for (const value of hasValues) {
			expect(parseScryfallSearch(`has:${value}`).errors, value).toEqual([]);
		}
	});

	it('supports negated Oracle tags', () => {
		expect(parseScryfallSearch('-otag:burn').filters).toContainEqual({
			kind: 'oracleTag',
			value: 'burn',
			negate: true
		});
	});

	it('rejects unsupported Oracle-tag operators without leaking into name terms', () => {
		const ast = parseScryfallSearch('otag>=draw');
		expect(ast.errors).toHaveLength(1);
		expect(ast.nameTerms).toEqual([]);
		expect(ast.filters).toEqual([]);
	});

	// ── mv:/cmc: ─────────────────────────────────────────────────────────────

	it('mv: with numeric operators', () => {
		const ast = parseScryfallSearch('mv>=3 cmc:2');
		const mvFilters = ast.filters.filter((f) => f.kind === 'mv') as any[];
		expect(mvFilters).toHaveLength(2);
		expect(mvFilters[0]).toMatchObject({ op: '>=', val: 3 });
		expect(mvFilters[1]).toMatchObject({ op: '=', val: 2 });
	});

	it('mv=3 is accepted (= treated like : for mana value)', () => {
		const ast = parseScryfallSearch('mv=3');
		expect(ast.errors).toEqual([]);
		const mv = ast.filters.find((f) => f.kind === 'mv') as any;
		expect(mv).toMatchObject({ op: '=', val: 3 });
	});

	it('mv with non-numeric value is a validation error', () => {
		const ast = parseScryfallSearch('mv:foo');
		expect(ast.errors).toHaveLength(1);
		expect(ast.errors[0].message).toMatch(/number/);
		expect(ast.nameTerms).toEqual([]);
	});

	// ── s:/set:/e: ────────────────────────────────────────────────────────────

	it('s:, set:, e: aliases', () => {
		for (const tok of ['s:znr', 'set:znr', 'e:znr']) {
			const ast = parseScryfallSearch(tok);
			expect(ast.filters).toContainEqual({ kind: 'set', value: 'znr', negate: false });
			expect(ast.errors).toEqual([]);
		}
	});

	it('set>= is an invalid operator', () => {
		const ast = parseScryfallSearch('set>=znr');
		expect(ast.errors).toHaveLength(1);
		expect(ast.nameTerms).toEqual([]);
	});

	// ── cn:/number: ───────────────────────────────────────────────────────────

	it('cn: and number: aliases', () => {
		expect(parseScryfallSearch('cn:100').filters).toContainEqual({
			kind: 'cn',
			value: '100',
			negate: false
		});
		expect(parseScryfallSearch('number:100').filters).toContainEqual({
			kind: 'cn',
			value: '100',
			negate: false
		});
	});

	it('cn supports numeric comparison operators', () => {
		const ast = parseScryfallSearch('cn>=100');
		expect(ast.errors).toEqual([]);
		expect(ast.filters).toContainEqual({
			kind: 'cn',
			op: '>=',
			value: '100',
			negate: false
		});
	});

	// ── r:/rarity: ────────────────────────────────────────────────────────────

	it('r: short forms', () => {
		expect(parseScryfallSearch('r:r').filters).toContainEqual({
			kind: 'rarity',
			value: 'rare',
			negate: false
		});
		expect(parseScryfallSearch('r:m').filters).toContainEqual({
			kind: 'rarity',
			value: 'mythic',
			negate: false
		});
		expect(parseScryfallSearch('rarity:common').filters).toContainEqual({
			kind: 'rarity',
			value: 'common',
			negate: false
		});
	});

	it('rarity supports Scryfall comparison operators', () => {
		const ast = parseScryfallSearch('r>=rare');
		expect(ast.errors).toEqual([]);
		expect(ast.filters).toContainEqual({
			kind: 'rarity',
			op: '>=',
			value: 'rare',
			negate: false
		});
	});

	it('unknown rarity is a validation error', () => {
		const ast = parseScryfallSearch('r:legendary');
		expect(ast.errors).toHaveLength(1);
		expect(ast.nameTerms).toEqual([]);
	});

	// ── color ─────────────────────────────────────────────────────────────────

	it('c:W single letter', () => {
		expect(parseScryfallSearch('c:W').filters).toContainEqual({
			kind: 'color',
			chars: ['W'],
			colorless: false,
			op: '=',
			negate: false
		});
	});

	it('c:white full name', () => {
		const ast = parseScryfallSearch('c:white');
		const f = ast.filters.find((f) => f.kind === 'color') as any;
		expect(f?.chars).toEqual(['W']);
	});

	it('c:colorless full name', () => {
		const ast = parseScryfallSearch('c:colorless');
		const f = ast.filters.find((f) => f.kind === 'color') as any;
		expect(f?.colorless).toBe(true);
		expect(f?.chars).toEqual([]);
	});

	it('c:C colorless letter', () => {
		expect(parseScryfallSearch('c:C').filters).toContainEqual({
			kind: 'color',
			chars: [],
			colorless: true,
			op: '=',
			negate: false
		});
	});

	it('c<=WU and c>=W operator parsing', () => {
		expect((parseScryfallSearch('c<=WU').filters[0] as any).op).toBe('<=');
		expect((parseScryfallSearch('c>=W').filters[0] as any).op).toBe('>=');
	});

	it('c= treated as exact (same as c:)', () => {
		const ast = parseScryfallSearch('c=WU');
		expect(ast.errors).toEqual([]);
		const f = ast.filters.find((f) => f.kind === 'color') as any;
		expect(f?.op).toBe('=');
	});

	it('c< strict operator is a validation error', () => {
		const ast = parseScryfallSearch('c<W');
		expect(ast.errors).toHaveLength(1);
		expect(ast.nameTerms).toEqual([]);
	});

	it('c:WC is a validation error (colorless + colored)', () => {
		const ast = parseScryfallSearch('c:WC');
		expect(ast.errors).toHaveLength(1);
		expect(ast.nameTerms).toEqual([]);
	});

	it('c:X unknown letter is a validation error', () => {
		const ast = parseScryfallSearch('c:X');
		expect(ast.errors).toHaveLength(1);
		expect(ast.nameTerms).toEqual([]);
	});

	// ── identity ──────────────────────────────────────────────────────────────

	it('ci:, id:, identity: aliases', () => {
		for (const tok of ['ci:W', 'id:W', 'identity:W']) {
			const ast = parseScryfallSearch(tok);
			expect(ast.filters).toContainEqual({
				kind: 'identity',
				chars: ['W'],
				colorless: false,
				op: '=',
				negate: false
			});
		}
	});

	it('id:c is colorless identity', () => {
		const ast = parseScryfallSearch('id:c');
		const f = ast.filters.find((f) => f.kind === 'identity') as any;
		expect(f?.colorless).toBe(true);
		expect(f?.chars).toEqual([]);
	});

	// ── sort / direction ──────────────────────────────────────────────────────

	it('sort: and order: aliases', () => {
		expect(parseScryfallSearch('sort:price').sort).toBe('price');
		expect(parseScryfallSearch('order:edhrec').sort).toBe('edhrec');
		expect(parseScryfallSearch('sort:mv').sort).toBe('mv');
		expect(parseScryfallSearch('sort:cmc').sort).toBe('mv');
		expect(parseScryfallSearch('sort:set').sort).toBe('set');
	});

	it('direction:desc and direction:asc', () => {
		expect(parseScryfallSearch('direction:desc').direction).toBe('desc');
		expect(parseScryfallSearch('direction:asc').direction).toBe('asc');
	});

	it('-sort:price is a negation error', () => {
		const ast = parseScryfallSearch('-sort:price');
		expect(ast.errors).toHaveLength(1);
		expect(ast.errors[0].message).toMatch(/cannot be negated/i);
		expect(ast.nameTerms).toEqual([]);
	});

	it('-direction:desc is a negation error', () => {
		const ast = parseScryfallSearch('-direction:desc');
		expect(ast.errors).toHaveLength(1);
		expect(ast.errors[0].message).toMatch(/cannot be negated/i);
		expect(ast.nameTerms).toEqual([]);
	});

	it('-order:name is a negation error', () => {
		const ast = parseScryfallSearch('-order:name');
		expect(ast.errors).toHaveLength(1);
		expect(ast.errors[0].message).toMatch(/cannot be negated/i);
		expect(ast.nameTerms).toEqual([]);
	});

	it('unknown sort field is a validation error', () => {
		const ast = parseScryfallSearch('sort:foobar');
		expect(ast.errors).toHaveLength(1);
		expect(ast.nameTerms).toEqual([]);
	});

	// ── Negation ──────────────────────────────────────────────────────────────

	it('-t:instant negates type filter', () => {
		const ast = parseScryfallSearch('-t:instant');
		const f = ast.filters.find((f) => f.kind === 'type') as any;
		expect(f?.negate).toBe(true);
	});

	it('-c:W negates color filter', () => {
		const ast = parseScryfallSearch('-c:W');
		const f = ast.filters.find((f) => f.kind === 'color') as any;
		expect(f?.negate).toBe(true);
	});

	// ── Invalid tokens never become name terms ─────────────────────────────────

	it('invalid operator token is consumed and does not appear in nameTerms', () => {
		const ast = parseScryfallSearch('t>=creature');
		expect(ast.nameTerms).toEqual([]);
	});

	it('unknown field token is consumed as error and does not appear in nameTerms', () => {
		const ast = parseScryfallSearch('foo:bar');
		expect(ast.errors).toHaveLength(1);
		expect(ast.nameTerms).toEqual([]);
	});

	it('multiple errors accumulate, none become name terms', () => {
		const ast = parseScryfallSearch('t>=creature c<W name>bolt');
		expect(ast.errors.length).toBeGreaterThanOrEqual(3);
		expect(ast.nameTerms).toEqual([]);
	});

	it('invalid token mixed with valid tokens and bare text', () => {
		const ast = parseScryfallSearch('lightning t>=creature bolt');
		expect(ast.nameTerms.map((t) => t.value)).toContain('lightning');
		expect(ast.nameTerms.map((t) => t.value)).toContain('bolt');
		expect(ast.nameTerms.map((t) => t.value)).not.toContain('creature');
		expect(ast.errors).toHaveLength(1);
	});

	// ── Misc ──────────────────────────────────────────────────────────────────

	it('quoted value with spaces', () => {
		const ast = parseScryfallSearch('t:"Legendary Creature"');
		expect(ast.filters).toContainEqual({
			kind: 'type',
			value: 'Legendary Creature',
			negate: false
		});
	});
});

// ── buildNameConditions shape ─────────────────────────────────────────────────

describe('buildNameConditions', () => {
	it('returns empty array for no name terms', () => {
		const conditions = buildNameConditions([], 'col' as any);
		expect(conditions).toEqual([]);
	});

	it('returns one condition per term', () => {
		const ast = parseScryfallSearch('Ring Sol');
		const conditions = buildNameConditions(ast.nameTerms, 'col' as any);
		expect(conditions).toHaveLength(2);
	});

	it('negative term produces NOT ILIKE condition (contains "not")', () => {
		const ast = parseScryfallSearch('-name:Sol');
		const conditions = buildNameConditions(ast.nameTerms, 'col' as any);
		expect(conditions).toHaveLength(1);
		// The condition object should be a NOT wrapper; just verify it exists and differs from positive
		const posConditions = buildNameConditions([{ value: 'Sol', negate: false }], 'col' as any);
		expect(conditions[0]).not.toEqual(posConditions[0]);
	});
});

// ── Shared collection sorting ─────────────────────────────────────────────────

describe('applySortToEntries', () => {
	const entries = [
		{
			name: 'Known Two',
			setCode: 'tst',
			collectorNumber: '2',
			foil: false,
			cmc: 2,
			priceUsd: 2,
			priceUsdFoil: null,
			edhrecRank: 20
		},
		{
			name: 'Unknown',
			setCode: 'tst',
			collectorNumber: '3',
			foil: false,
			cmc: null,
			priceUsd: null,
			priceUsdFoil: null,
			edhrecRank: null
		},
		{
			name: 'Known One',
			setCode: 'tst',
			collectorNumber: '1',
			foil: false,
			cmc: 1,
			priceUsd: 1,
			priceUsdFoil: null,
			edhrecRank: 10
		}
	];

	it('sorts null mana values last ascending', () => {
		const sorted = applySortToEntries(entries, parseScryfallSearch('sort:mv'));
		expect(sorted.map((entry) => entry.name)).toEqual(['Known One', 'Known Two', 'Unknown']);
	});

	it('sorts null mana values last descending', () => {
		const sorted = applySortToEntries(entries, parseScryfallSearch('sort:mv direction:desc'));
		expect(sorted.map((entry) => entry.name)).toEqual(['Known Two', 'Known One', 'Unknown']);
	});

	it('keeps entries with missing Scryfall metadata in sort results', () => {
		const sorted = applySortToEntries(entries, parseScryfallSearch('sort:price'));
		expect(sorted).toHaveLength(entries.length);
		expect(sorted[sorted.length - 1].name).toBe('Unknown');
	});
});

// ── Multi-faced card mapping ──────────────────────────────────────────────────

describe('mapToRow — multi-faced cards', () => {
	const baseCard = {
		id: 'card-id',
		name: 'Front // Back',
		set: 'tst',
		collector_number: '1',
		cmc: 3,
		color_identity: ['W'],
		rarity: 'rare',
		prices: { usd: '1.00', usd_foil: null }
	};

	it('deduplicates the same color across transform faces', () => {
		const row = mapToRow({
			...baseCard,
			card_faces: [
				{ type_line: 'Creature', colors: ['W'] },
				{ type_line: 'Creature', colors: ['W'] }
			]
		});
		expect(JSON.parse(row.colors!)).toEqual(['W']);
	});

	it('unions different colors across modal faces', () => {
		const row = mapToRow({
			...baseCard,
			color_identity: ['W', 'B'],
			card_faces: [
				{ type_line: 'Creature', colors: ['W'] },
				{ type_line: 'Creature', colors: ['B'] }
			]
		});
		expect(JSON.parse(row.colors!)).toEqual(['W', 'B']);
	});

	it('stores an empty array for a genuinely colorless double-faced card', () => {
		const row = mapToRow({
			...baseCard,
			color_identity: [],
			card_faces: [
				{ type_line: 'Land', colors: [] },
				{ type_line: 'Artifact', colors: [] }
			]
		});
		expect(row.colors).toBe('[]');
	});

	it('combines face-only Oracle text, mana costs, and type lines', () => {
		const row = mapToRow({
			...baseCard,
			card_faces: [
				{
					type_line: 'Creature — Human',
					mana_cost: '{1}{W}',
					oracle_text: 'First face text.',
					colors: ['W']
				},
				{
					type_line: 'Creature — Vampire',
					mana_cost: '{2}{B}',
					oracle_text: 'Second face text.',
					colors: ['B']
				}
			]
		});
		expect(row.type_line).toBe('Creature — Human // Creature — Vampire');
		expect(row.mana_cost).toBe('{1}{W} // {2}{B}');
		expect(row.oracle_text).toBe('First face text.\n//\nSecond face text.');
	});

	it('maps gameplay and attribution search metadata with face fallbacks', () => {
		const row = mapToRow({
			...baseCard,
			keywords: ['Flying', 'Ward'],
			produced_mana: ['U'],
			watermark: 'azorius',
			released_at: '2024-02-09',
			lang: 'ja',
			games: ['paper', 'arena'],
			finishes: ['nonfoil', 'foil'],
			frame: '2015',
			frame_effects: ['showcase'],
			layout: 'transform',
			set_name: 'Test Expansion',
			set_type: 'expansion',
			promo: true,
			promo_types: ['boosterfun'],
			reprint: true,
			reserved: false,
			digital: false,
			full_art: true,
			textless: false,
			oversized: false,
			variation: true,
			highres_image: true,
			security_stamp: 'oval',
			border_color: 'borderless',
			booster: true,
			story_spotlight: false,
			printed_name: 'Localized Name',
			game_changer: true,
			color_indicator: ['W', 'U'],
			preview: { source: 'Scryfall' },
			card_faces: [
				{ type_line: 'Creature', power: '2', toughness: '3', artist: 'Front Artist' },
				{ type_line: 'Planeswalker', loyalty: '4', flavor_text: 'Back flavor.' }
			]
		});
		expect(row.power).toBe('2');
		expect(row.toughness).toBe('3');
		expect(row.loyalty).toBe('4');
		expect(row.artist).toBe('Front Artist');
		expect(row.flavor_text).toBe('Back flavor.');
		expect(JSON.parse(row.keywords!)).toEqual(['Flying', 'Ward']);
		expect(JSON.parse(row.produced_mana!)).toEqual(['U']);
		expect(row.watermark).toBe('azorius');
		expect(row.released_at).toBe('2024-02-09');
		expect(JSON.parse(row.printing_metadata!)).toMatchObject({
			lang: 'ja',
			games: ['paper', 'arena'],
			finishes: ['nonfoil', 'foil'],
			frameEffects: ['showcase'],
			layout: 'transform',
			setName: 'Test Expansion',
			setType: 'expansion',
			promo: true,
			promoTypes: ['boosterfun'],
			fullArt: true,
			securityStamp: 'oval',
			borderColor: 'borderless',
			printedName: 'Localized Name',
			gameChanger: true,
			colorIndicator: ['W', 'U'],
			previewSource: 'Scryfall'
		});
	});

	it('falls back to face colors when a malformed response supplies top-level null', () => {
		const row = mapToRow({
			...baseCard,
			colors: null as unknown as string[],
			card_faces: [{ colors: ['G'] }]
		});
		expect(row.colors).toBe('["G"]');
	});

	it('uses one shared face Oracle ID when the top-level value is absent', () => {
		const row = mapToRow({
			...baseCard,
			card_faces: [
				{ oracle_id: 'shared-oracle-id', type_line: 'Creature' },
				{ oracle_id: 'shared-oracle-id', type_line: 'Creature' }
			]
		});
		expect(row.oracle_id).toBe('shared-oracle-id');
	});

	it('does not guess when faces have different Oracle IDs', () => {
		const row = mapToRow({
			...baseCard,
			card_faces: [
				{ oracle_id: 'front-oracle-id', type_line: 'Creature' },
				{ oracle_id: 'back-oracle-id', type_line: 'Creature' }
			]
		});
		expect(row.oracle_id).toBeNull();
	});
});

// ── Executor tests ────────────────────────────────────────────────────────────

describe('executeSearch — candidate-bounded SQLite executor', () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = tempDbPath();
		const d = openDb(dbPath);
		seedCard(d, {
			id: 'w1',
			name: 'White Knight',
			oracle_id: 'ow',
			type_line: 'Legendary Creature — Human Knight Warrior',
			oracle_text: 'First strike\nProtection from black',
			cmc: 2,
			colors: '["W"]',
			color_identity: '["W"]',
			rarity: 'uncommon',
			edhrec_rank: 1000,
			price_usd: 1.5,
			set_code: 'tst',
			collector_number: '5',
			legalities: '{"commander":"legal","modern":"legal"}',
			power: '2',
			toughness: '2',
			keywords: '["First strike","Protection from black"]',
			artist: 'Daniel Gelon',
			released_at: '1995-04-01',
			printing_metadata: printingMetadata({ frame: '1997', gameChanger: true, reserved: true })
		});
		seedCard(d, {
			id: 'u1',
			name: 'Counterspell',
			oracle_id: 'ou',
			type_line: 'Instant',
			cmc: 2,
			colors: '["U"]',
			color_identity: '["U"]',
			rarity: 'common',
			edhrec_rank: 500,
			price_usd: 3.0,
			set_code: 'tst',
			collector_number: '3',
			artist: 'Mark Poole',
			flavor_text: 'The ultimate answer.',
			watermark: 'azorius',
			released_at: '1997-06-09',
			printing_metadata: printingMetadata({
				lang: 'ja',
				finishes: ['nonfoil', 'foil'],
				frame: '1997',
				securityStamp: 'oval',
				promo: true,
				promoTypes: ['prerelease', 'datestamped'],
				previewSource: 'Scryfall',
				colorIndicator: ['U']
			})
		});
		seedCard(d, {
			id: 'wu1',
			name: 'Azorius Charm',
			oracle_id: 'owu',
			type_line: 'Instant',
			mana_cost: '{W/U}{W/U}',
			cmc: 2,
			colors: '["W","U"]',
			color_identity: '["W","U"]',
			rarity: 'uncommon',
			edhrec_rank: 2000,
			price_usd: 0.5,
			set_code: 'tst',
			collector_number: '1',
			watermark: 'azorius',
			released_at: '2012-10-05',
			printing_metadata: printingMetadata({
				games: ['paper', 'arena'],
				setName: 'Return to Ravnica',
				layout: 'modal_dfc',
				fullArt: true,
				frameEffects: ['showcase'],
				storySpotlight: true
			})
		});
		seedCard(d, {
			id: 'cl1',
			name: 'Sol Ring',
			oracle_id: 'ocl',
			type_line: 'Artifact',
			cmc: 1,
			colors: '[]',
			color_identity: '[]',
			rarity: 'uncommon',
			edhrec_rank: 1,
			price_usd: 5.0,
			set_code: 'tst',
			collector_number: '2',
			produced_mana: '["C"]',
			artist: 'Mark Tedin',
			released_at: '1993-08-05',
			printing_metadata: printingMetadata({
				games: ['paper', 'mtgo'],
				finishes: ['foil', 'etched'],
				frame: '1993',
				setName: 'Limited Edition Alpha',
				setType: 'core',
				reprint: true
			})
		});
		seedCard(d, {
			id: 'null1',
			name: 'Unknown Card',
			type_line: 'Artifact',
			cmc: 3,
			colors: null,
			color_identity: null,
			rarity: null,
			edhrec_rank: null,
			price_usd: null,
			set_code: 'tst',
			collector_number: '4'
		});
		seedCard(d, {
			id: 'r1',
			name: 'Lightning Bolt',
			oracle_id: 'or',
			type_line: 'Instant',
			mana_cost: '{R/P}',
			cmc: 1,
			colors: '["R"]',
			color_identity: '["R"]',
			rarity: 'common',
			edhrec_rank: 100,
			price_usd: 2.0,
			set_code: 'lea',
			collector_number: '161',
			legalities: '{"commander":"legal","modern":"legal"}'
		});
		seedCard(d, {
			id: 'tap-creature',
			name: 'Azorius Tactician',
			oracle_id: 'otap-creature',
			type_line: 'Creature — Human Wizard',
			oracle_text: 'When this creature enters, tap target permanent.',
			mana_cost: '{W}{U}',
			cmc: 2,
			colors: '["W","U"]',
			color_identity: '["W","U"]',
			printing_metadata: printingMetadata()
		});
		seedCard(d, {
			id: 'tap-artifact',
			name: 'Azorius Relay',
			oracle_id: 'otap-artifact',
			type_line: 'Artifact',
			oracle_text: 'Tap an untapped creature you control: Draw a card.',
			mana_cost: '{2}',
			cmc: 2,
			colors: '[]',
			color_identity: '["W","U"]',
			printing_metadata: printingMetadata()
		});
		seedCard(d, {
			id: 'tap-planeswalker',
			name: 'Azorius Arbiter',
			oracle_id: 'otap-planeswalker',
			type_line: 'Legendary Planeswalker — Test',
			oracle_text: '+1: Tap target creature.',
			mana_cost: '{2}{W}{U}',
			cmc: 4,
			colors: '["W","U"]',
			color_identity: '["W","U"]',
			loyalty: '4',
			printing_metadata: printingMetadata()
		});
		seedCard(d, {
			id: 'tap-wrong-identity',
			name: 'White Tactician',
			oracle_id: 'otap-white',
			type_line: 'Creature — Human Soldier',
			oracle_text: 'When this creature enters, tap target creature.',
			mana_cost: '{W}',
			cmc: 1,
			colors: '["W"]',
			color_identity: '["W"]',
			printing_metadata: printingMetadata()
		});
		d.exec(`
			CREATE TABLE scryfall_oracle_tags (
				id TEXT PRIMARY KEY,
				label TEXT NOT NULL COLLATE NOCASE,
				description TEXT
			);
			CREATE TABLE scryfall_oracle_tag_cards (
				tag_id TEXT NOT NULL,
				oracle_id TEXT NOT NULL,
				PRIMARY KEY (tag_id, oracle_id)
			);
			INSERT INTO scryfall_oracle_tags (id, label) VALUES
				('life', 'Life Gain'), ('draw', 'Card Draw'), ('burn', 'Burn');
			INSERT INTO scryfall_oracle_tag_cards (tag_id, oracle_id) VALUES
				('life', 'ow'), ('life', 'owu'),
				('draw', 'ou'), ('draw', 'owu'),
				('burn', 'or');
		`);
		d.close();
	});

	afterEach(() => {
		removeTempDb(dbPath);
	});

	const ALL = ['w1', 'u1', 'wu1', 'cl1', 'null1', 'r1'];
	const COMPATIBILITY_CANDIDATES = [
		...ALL,
		'tap-creature',
		'tap-artifact',
		'tap-planeswalker',
		'tap-wrong-identity'
	];

	// ── Core executor contract ─────────────────────────────────────────────────

	it('returns null when no filters and no sort override', () => {
		expect(executeSearch(parseScryfallSearch(''), ALL, dbPath)).toBeNull();
	});

	it('returns [] when candidateIds is empty', () => {
		expect(executeSearch(parseScryfallSearch('t:creature'), [], dbPath)).toEqual([]);
	});

	it('result bounded by candidateIds — excludes IDs not in candidate set', () => {
		// Only pass u1 and r1 — wu1 is also an Instant but not in candidates
		const result = executeSearch(parseScryfallSearch('t:Instant'), ['u1', 'r1'], dbPath)!;
		expect(result).toContain('u1');
		expect(result).toContain('r1');
		expect(result).not.toContain('wu1');
	});

	it('sort override alone returns null so routes preserve unlinked collection entries', () => {
		expect(executeSearch(parseScryfallSearch('sort:price'), ALL, dbPath)).toBeNull();
		expect(executeSearch(parseScryfallSearch('sort:name direction:desc'), ALL, dbPath)).toBeNull();
		expect(executeSearch(parseScryfallSearch('sort:set'), ALL, dbPath)).toBeNull();
		expect(executeSearch(parseScryfallSearch('sort:mv'), ALL, dbPath)).toBeNull();
	});

	it('closes fresh SQLite connection — dbPath can be deleted after call', () => {
		executeSearch(parseScryfallSearch('t:Creature'), ALL, dbPath);
		// If connection not closed this would fail on Windows
		expect(() => fs.unlinkSync(dbPath)).not.toThrow();
		// Recreate so afterEach doesn't error
		fs.writeFileSync(dbPath, '');
	});

	// ── mv=3 via executor ─────────────────────────────────────────────────────

	it('mv=3 matches same cards as mv:3', () => {
		const eqResult = executeSearch(parseScryfallSearch('mv=3'), ALL, dbPath)!;
		const colonResult = executeSearch(parseScryfallSearch('mv:3'), ALL, dbPath)!;
		expect(eqResult.sort()).toEqual(colonResult.sort());
		expect(eqResult).toContain('null1'); // cmc=3
		expect(eqResult).not.toContain('w1'); // cmc=2
	});

	// ── Filter types ──────────────────────────────────────────────────────────

	it('type filter', () => {
		const result = executeSearch(parseScryfallSearch('t:Instant'), ALL, dbPath)!;
		expect(result).toContain('u1');
		expect(result).toContain('wu1');
		expect(result).toContain('r1');
		expect(result).not.toContain('w1');
	});

	it('executes OR, parentheses, and implicit AND with Scryfall precedence', () => {
		const result = executeSearch(
			parseScryfallSearch('t:creature OR (t:artifact mv<=1)'),
			ALL,
			dbPath
		)!;
		expect(result).toEqual(expect.arrayContaining(['w1', 'cl1']));
		expect(result).not.toContain('null1');
		expect(result).not.toContain('u1');
	});

	it('executes negated parenthesized expressions', () => {
		const result = executeSearch(parseScryfallSearch('-(t:instant OR t:artifact)'), ALL, dbPath)!;
		expect(result).toEqual(['w1']);
	});

	it('executes exact-name and regular-expression searches', () => {
		expect(executeSearch(parseScryfallSearch('!"Sol Ring"'), ALL, dbPath)).toEqual(['cl1']);
		expect(executeSearch(parseScryfallSearch('/^(Sol|Counter)/'), ALL, dbPath)).toEqual([
			'u1',
			'cl1'
		]);
		expect(executeSearch(parseScryfallSearch('t:/^Art/'), ALL, dbPath)).toEqual(['cl1', 'null1']);
	});

	it('combines local Oracle tags with other filters inside one boolean expression', () => {
		const sharedTags = new Map([['life gain', new Set(['ow', 'owu'])]]);
		const result = executeSearch(
			parseScryfallSearch('otag:\"Life Gain\" OR c:R'),
			ALL,
			dbPath,
			sharedTags
		)!;
		expect(result).toEqual(expect.arrayContaining(['w1', 'wu1', 'r1']));
		expect(result).not.toContain('u1');
	});

	it('set filter (e: alias)', () => {
		const result = executeSearch(parseScryfallSearch('e:lea'), ALL, dbPath)!;
		expect(result).toEqual(['r1']);
	});

	it('rarity filter', () => {
		const result = executeSearch(parseScryfallSearch('r:common'), ALL, dbPath)!;
		expect(result).toContain('u1');
		expect(result).toContain('r1');
		expect(result).not.toContain('w1');
	});

	it('rarity and collector-number comparisons follow Scryfall operators', () => {
		const rareOrHigher = executeSearch(parseScryfallSearch('r>=rare'), ALL, dbPath)!;
		expect(rareOrHigher).toEqual([]);
		const collector = executeSearch(parseScryfallSearch('cn>=100'), ALL, dbPath)!;
		expect(collector).toEqual(['r1']);
	});

	it('filters by USD price and format legality', () => {
		const budget = executeSearch(parseScryfallSearch('usd<=1.5'), ALL, dbPath)!;
		expect(budget).toEqual(expect.arrayContaining(['w1', 'wu1']));
		expect(budget).not.toContain('r1');
		const commander = executeSearch(parseScryfallSearch('f:commander'), ALL, dbPath)!;
		expect(commander).toEqual(expect.arrayContaining(['w1', 'r1']));
		expect(commander).not.toContain('u1');
	});

	it('filters numeric and symbolic combat stats', () => {
		expect(executeSearch(parseScryfallSearch('pow:2 tou>=2'), ALL, dbPath)).toEqual(['w1']);
		expect(executeSearch(parseScryfallSearch('pow>2'), ALL, dbPath)).toEqual([]);
		expect(executeSearch(parseScryfallSearch('-pow:2'), ALL, dbPath)).toEqual(
			expect.arrayContaining(['u1', 'cl1'])
		);
	});

	it('filters keywords and produced mana case-insensitively', () => {
		expect(executeSearch(parseScryfallSearch('kw:\"first strike\"'), ALL, dbPath)).toEqual(['w1']);
		expect(executeSearch(parseScryfallSearch('produces:c'), ALL, dbPath)).toEqual(['cl1']);
		expect(executeSearch(parseScryfallSearch('-produces:c'), ALL, dbPath)).not.toContain('cl1');
	});

	it('filters artist, flavor text, watermark, and release date', () => {
		expect(executeSearch(parseScryfallSearch('artist:Poole'), ALL, dbPath)).toEqual(['u1']);
		expect(executeSearch(parseScryfallSearch('ft:/ultimate answer/'), ALL, dbPath)).toEqual(['u1']);
		expect(executeSearch(parseScryfallSearch('watermark:azorius'), ALL, dbPath)).toEqual([
			'wu1',
			'u1'
		]);
		expect(executeSearch(parseScryfallSearch('year:1997'), ALL, dbPath)).toEqual(['u1']);
		expect(executeSearch(parseScryfallSearch('date>=2010'), ALL, dbPath)).toEqual(['wu1']);
	});

	it('filters language, game, finish, frame, layout, set type, border, and stamp', () => {
		expect(executeSearch(parseScryfallSearch('lang:japanese'), ALL, dbPath)).toEqual(['u1']);
		expect(executeSearch(parseScryfallSearch('game:arena'), ALL, dbPath)).toEqual(['wu1']);
		expect(executeSearch(parseScryfallSearch('finish:etched'), ALL, dbPath)).toEqual(['cl1']);
		expect(executeSearch(parseScryfallSearch('frame:1997'), ALL, dbPath)).toEqual(['u1', 'w1']);
		expect(executeSearch(parseScryfallSearch('layout:normal st:core'), ALL, dbPath)).toEqual([
			'cl1'
		]);
		expect(executeSearch(parseScryfallSearch('border:black stamp:oval'), ALL, dbPath)).toEqual([
			'u1'
		]);
	});

	it('in: matches current printing set code/name/type, language, or game', () => {
		expect(executeSearch(parseScryfallSearch('in:tst'), ALL, dbPath)).toEqual([
			'wu1',
			'u1',
			'cl1',
			'null1',
			'w1'
		]);
		expect(executeSearch(parseScryfallSearch('in:\"Return to Ravnica\"'), ALL, dbPath)).toEqual([
			'wu1'
		]);
		expect(executeSearch(parseScryfallSearch('in:core'), ALL, dbPath)).toEqual(['cl1']);
		expect(executeSearch(parseScryfallSearch('in:japanese'), ALL, dbPath)).toEqual(['u1']);
		expect(executeSearch(parseScryfallSearch('in:arena'), ALL, dbPath)).toEqual(['wu1']);
	});

	it('negated printing metadata includes rows that lack that property', () => {
		const result = executeSearch(parseScryfallSearch('-game:arena'), ALL, dbPath)!;
		expect(result).not.toContain('wu1');
		expect(result).toContain('null1');
		expect(result).toContain('r1');
	});

	it('evaluates commander, card-class, and ability-only predicates', () => {
		expect(executeSearch(parseScryfallSearch('is:commander'), ALL, dbPath)).toEqual(['w1']);
		expect(executeSearch(parseScryfallSearch('is:brawler'), ALL, dbPath)).toEqual(['w1']);
		expect(executeSearch(parseScryfallSearch('is:party'), ALL, dbPath)).toEqual(['w1']);
		expect(executeSearch(parseScryfallSearch('is:frenchvanilla'), ALL, dbPath)).toEqual(['w1']);
		expect(executeSearch(parseScryfallSearch('is:historic'), ALL, dbPath)).toEqual([
			'cl1',
			'null1',
			'w1'
		]);
	});

	it('evaluates mana, layout, frame, and finish predicates', () => {
		expect(executeSearch(parseScryfallSearch('is:hybrid'), ALL, dbPath)).toEqual(['wu1']);
		expect(executeSearch(parseScryfallSearch('is:phyrexian'), ALL, dbPath)).toEqual(['r1']);
		expect(executeSearch(parseScryfallSearch('is:dfc is:mdfc'), ALL, dbPath)).toEqual(['wu1']);
		expect(executeSearch(parseScryfallSearch('is:old'), ALL, dbPath)).toEqual(['u1', 'cl1', 'w1']);
		expect(executeSearch(parseScryfallSearch('is:etched'), ALL, dbPath)).toEqual(['cl1']);
	});

	it('evaluates canonical printing flags and promo predicates', () => {
		expect(executeSearch(parseScryfallSearch('is:reserved is:gamechanger'), ALL, dbPath)).toEqual([
			'w1'
		]);
		expect(
			executeSearch(parseScryfallSearch('is:promo is:prerelease is:datestamped'), ALL, dbPath)
		).toEqual(['u1']);
		expect(
			executeSearch(parseScryfallSearch('is:full is:showcase is:spotlight'), ALL, dbPath)
		).toEqual(['wu1']);
		expect(executeSearch(parseScryfallSearch('is:scryfallpreview'), ALL, dbPath)).toEqual(['u1']);
		expect(executeSearch(parseScryfallSearch('is:reprint'), ALL, dbPath)).toEqual(['cl1']);
	});

	it('evaluates has: predicates from canonical fields', () => {
		expect(executeSearch(parseScryfallSearch('has:indicator'), ALL, dbPath)).toEqual(['u1']);
		expect(executeSearch(parseScryfallSearch('has:watermark'), ALL, dbPath)).toEqual(['wu1', 'u1']);
		expect(executeSearch(parseScryfallSearch('has:flavor'), ALL, dbPath)).toEqual(['u1']);
		expect(executeSearch(parseScryfallSearch('has:pt'), ALL, dbPath)).toEqual(['w1']);
		expect(executeSearch(parseScryfallSearch('has:multifaced'), ALL, dbPath)).toEqual(['wu1']);
		expect(executeSearch(parseScryfallSearch('has:securitystamp'), ALL, dbPath)).toEqual(['u1']);
	});

	it('supports not: and normal negation inside boolean expressions', () => {
		const notReprint = executeSearch(parseScryfallSearch('not:reprint'), ALL, dbPath)!;
		expect(notReprint).not.toContain('cl1');
		expect(notReprint).toContain('w1');
		expect(
			executeSearch(parseScryfallSearch('(is:commander OR is:mdfc) -is:promo'), ALL, dbPath)
		).toEqual(['wu1', 'w1']);
	});

	it.each(SCRYFALL_QUERY_CORPUS)('$name', ({ query, expectedIds, sharedOracleTags }) => {
		const ast = parseScryfallSearch(query);
		expect(ast.errors).toEqual([]);
		expect(executeSearch(ast, COMPATIBILITY_CANDIDATES, dbPath, sharedOracleTags)?.sort()).toEqual(
			[...expectedIds].sort()
		);
	});

	// ── Oracle tags ───────────────────────────────────────────────────────────

	it('matches Oracle tags case-insensitively', () => {
		const result = executeSearch(parseScryfallSearch('otag:"life gain"'), ALL, dbPath)!;
		expect(result).toEqual(expect.arrayContaining(['w1', 'wu1']));
		expect(result).not.toContain('u1');
	});

	it('repeated Oracle tags use AND semantics', () => {
		const result = executeSearch(
			parseScryfallSearch('otag:"Life Gain" oracle-tag:"Card Draw"'),
			ALL,
			dbPath
		)!;
		expect(result).toEqual(['wu1']);
	});

	it('negated Oracle tags exclude matches and cards without Oracle IDs', () => {
		const result = executeSearch(parseScryfallSearch('-otag:Burn'), ALL, dbPath)!;
		expect(result).not.toContain('r1');
		expect(result).not.toContain('null1');
		expect(result).toContain('w1');
	});

	it('Oracle tag results remain bounded by candidate IDs', () => {
		const result = executeSearch(parseScryfallSearch('otag:"Life Gain"'), ['w1', 'u1'], dbPath)!;
		expect(result).toEqual(['w1']);
	});

	// ── Color filters ─────────────────────────────────────────────────────────

	it('c:W exact — only white cards, not WU, not null', () => {
		const result = executeSearch(parseScryfallSearch('c:W'), ALL, dbPath)!;
		expect(result).toContain('w1');
		expect(result).not.toContain('wu1');
		expect(result).not.toContain('cl1');
		expect(result).not.toContain('null1');
	});

	it('c:green full name', () => {
		const result = executeSearch(parseScryfallSearch('c:green'), ALL, dbPath)!;
		expect(result).toEqual([]);
	});

	it('c=WU exact', () => {
		const result = executeSearch(parseScryfallSearch('c=WU'), ALL, dbPath)!;
		expect(result).toContain('wu1');
		expect(result).not.toContain('w1');
		expect(result).not.toContain('u1');
	});

	it('c<=WU subset — W, U, WU, colorless', () => {
		const result = executeSearch(parseScryfallSearch('c<=WU'), ALL, dbPath)!;
		expect(result).toContain('w1');
		expect(result).toContain('u1');
		expect(result).toContain('wu1');
		expect(result).toContain('cl1');
		expect(result).not.toContain('r1');
		expect(result).not.toContain('null1');
	});

	it('c>=W superset — W and WU', () => {
		const result = executeSearch(parseScryfallSearch('c>=W'), ALL, dbPath)!;
		expect(result).toContain('w1');
		expect(result).toContain('wu1');
		expect(result).not.toContain('u1');
		expect(result).not.toContain('cl1');
		expect(result).not.toContain('null1');
	});

	it('c:C — exactly colorless (empty array), not NULL', () => {
		const result = executeSearch(parseScryfallSearch('c:C'), ALL, dbPath)!;
		expect(result).toEqual(['cl1']);
		expect(result).not.toContain('null1');
	});

	it('c:colorless full name', () => {
		const result = executeSearch(parseScryfallSearch('c:colorless'), ALL, dbPath)!;
		expect(result).toEqual(['cl1']);
	});

	it('NULL colors never match positive color filter', () => {
		const result = executeSearch(parseScryfallSearch('c:W'), ['null1'], dbPath)!;
		expect(result).toEqual([]);
	});

	it('NULL colors excluded from negative color filter too', () => {
		const result = executeSearch(parseScryfallSearch('-c:R'), ['null1', 'w1'], dbPath)!;
		expect(result).not.toContain('null1');
		expect(result).toContain('w1');
	});

	// ── Identity filters ──────────────────────────────────────────────────────

	it('id:W exact identity', () => {
		const result = executeSearch(parseScryfallSearch('id:W'), ALL, dbPath)!;
		expect(result).toContain('w1');
		expect(result).not.toContain('wu1');
		expect(result).not.toContain('null1');
	});

	it('id:c — colorless identity (empty array), not NULL', () => {
		const result = executeSearch(parseScryfallSearch('id:c'), ALL, dbPath)!;
		expect(result).toEqual(['cl1']);
		expect(result).not.toContain('null1');
	});

	it('id<=WU subset — fits in WU commander', () => {
		const result = executeSearch(parseScryfallSearch('id<=WU'), ALL, dbPath)!;
		expect(result).toContain('w1');
		expect(result).toContain('u1');
		expect(result).toContain('wu1');
		expect(result).toContain('cl1');
		expect(result).not.toContain('r1');
		expect(result).not.toContain('null1');
	});

	it('id<=ug — fits in Simic (U+G)', () => {
		const result = executeSearch(parseScryfallSearch('id<=ug'), ALL, dbPath)!;
		expect(result).toContain('u1'); // U ⊆ {U,G}
		expect(result).toContain('cl1'); // [] ⊆ {U,G}
		expect(result).not.toContain('w1'); // W not in {U,G}
		expect(result).not.toContain('r1'); // R not in {U,G}
		expect(result).not.toContain('null1');
	});

	// ── Sort ──────────────────────────────────────────────────────────────────

	it('sort:name asc (default) — alphabetical order', () => {
		const nameMap: Record<string, string> = {
			w1: 'White Knight',
			u1: 'Counterspell',
			wu1: 'Azorius Charm',
			cl1: 'Sol Ring',
			null1: 'Unknown Card',
			r1: 'Lightning Bolt'
		};
		const ast = parseScryfallSearch('t:Instant');
		const result = executeSearch(ast, ALL, dbPath)!;
		const names = result.map((id) => nameMap[id]);
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
	});

	it('sort:name direction:desc — reverse alphabetical', () => {
		const nameMap: Record<string, string> = {
			w1: 'White Knight',
			u1: 'Counterspell',
			wu1: 'Azorius Charm',
			cl1: 'Sol Ring',
			null1: 'Unknown Card',
			r1: 'Lightning Bolt'
		};
		const result = executeSearch(
			parseScryfallSearch('mv>=0 sort:name direction:desc'),
			ALL,
			dbPath
		)!;
		for (let i = 0; i < result.length - 1; i++) {
			expect(nameMap[result[i]].localeCompare(nameMap[result[i + 1]])).toBeGreaterThanOrEqual(0);
		}
	});

	it('sort:price asc — nulls last', () => {
		const result = executeSearch(parseScryfallSearch('mv>=0 sort:price'), ALL, dbPath)!;
		expect(result[result.length - 1]).toBe('null1');
		// wu1($0.5) < r1($2) < u1($3) < w1($1.5) < cl1($5) — verify wu1 before cl1
		expect(result.indexOf('wu1')).toBeLessThan(result.indexOf('cl1'));
	});

	it('sort:price direction:desc — nulls still last', () => {
		const result = executeSearch(
			parseScryfallSearch('mv>=0 sort:price direction:desc'),
			ALL,
			dbPath
		)!;
		expect(result[result.length - 1]).toBe('null1');
		expect(result.indexOf('cl1')).toBeLessThan(result.indexOf('wu1'));
	});

	it('sort:edhrec asc — nulls last, cl1 first (rank=1)', () => {
		const result = executeSearch(parseScryfallSearch('mv>=0 sort:edhrec'), ALL, dbPath)!;
		expect(result[result.length - 1]).toBe('null1');
		expect(result[0]).toBe('cl1');
		expect(result[1]).toBe('r1');
	});

	it('sort:mv asc', () => {
		const result = executeSearch(parseScryfallSearch('mv>=0 sort:mv'), ALL, dbPath)!;
		const cl = result.indexOf('cl1'); // cmc=1
		const w = result.indexOf('w1'); // cmc=2
		const uk = result.indexOf('null1'); // cmc=3
		expect(cl).toBeLessThan(w);
		expect(w).toBeLessThan(uk);
	});

	it('sort:set asc — lea before tst', () => {
		const result = executeSearch(parseScryfallSearch('mv>=0 sort:set'), ALL, dbPath)!;
		expect(result[0]).toBe('r1'); // set=lea
	});

	// ── Chunking ──────────────────────────────────────────────────────────────

	it('chunked candidate IDs (>900) — correct results across chunks', () => {
		const d2 = openDb(dbPath);
		const extra: string[] = [];
		for (let i = 0; i < 905; i++) {
			const id = `extra_${i}`;
			seedCard(d2, {
				id,
				name: `Extra Card ${i}`,
				type_line: 'Creature',
				cmc: 1,
				colors: '["W"]',
				color_identity: '["W"]',
				rarity: 'common'
			});
			extra.push(id);
		}
		d2.close();
		const candidates = [...ALL, ...extra];
		const result = executeSearch(parseScryfallSearch('t:Creature'), candidates, dbPath)!;
		expect(result).toContain('w1');
		expect(result.length).toBe(906); // w1 + 905 extras
	});

	// ── Cache readiness ───────────────────────────────────────────────────────

	it('cache not ready — color filter without populated colors throws', () => {
		const p = tempDbPath();
		try {
			const d = openDb(p);
			seedCard(d, { id: 'old', name: 'Old Card', colors: null, color_identity: null });
			d.close();
			expect(() => executeSearch(parseScryfallSearch('c:W'), ['old'], p)).toThrow(
				CacheNotReadyError
			);
		} finally {
			removeTempDb(p);
		}
	});

	it('cache not ready — rarity filter without populated rarity throws', () => {
		const p = tempDbPath();
		try {
			const d = openDb(p);
			seedCard(d, { id: 'old', name: 'Old Card', rarity: null });
			d.close();
			expect(() => executeSearch(parseScryfallSearch('r:common'), ['old'], p)).toThrow(
				CacheNotReadyError
			);
		} finally {
			removeTempDb(p);
		}
	});

	it('cache not ready — newly migrated gameplay fields require a reseed', () => {
		const p = tempDbPath();
		try {
			const d = openDb(p);
			seedCard(d, { id: 'old', name: 'Old Card', keywords: null });
			d.close();
			expect(() => executeSearch(parseScryfallSearch('keyword:flying'), ['old'], p)).toThrow(
				/pnpm scryfall:seed/
			);
		} finally {
			removeTempDb(p);
		}
	});

	it('cache not ready — printing metadata filters require a reseed', () => {
		const p = tempDbPath();
		try {
			const d = openDb(p);
			seedCard(d, { id: 'old', name: 'Old Card', printing_metadata: null });
			d.close();
			expect(() => executeSearch(parseScryfallSearch('game:paper'), ['old'], p)).toThrow(
				/pnpm scryfall:seed/
			);
		} finally {
			removeTempDb(p);
		}
	});

	it('cache not ready — Oracle-tag filter names the tag refresh command', () => {
		const p = tempDbPath();
		try {
			const d = openDb(p);
			seedCard(d, { id: 'tagless', name: 'Tagless Card', oracle_id: 'oracle-tagless' });
			d.close();
			expect(() => executeSearch(parseScryfallSearch('otag:draw'), ['tagless'], p)).toThrow(
				/pnpm scryfall:tags/
			);
		} finally {
			removeTempDb(p);
		}
	});
});
