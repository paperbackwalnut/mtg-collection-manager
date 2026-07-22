/**
 * src/lib/server/scryfall-search.ts
 *
 * Pure Scryfall-style search parser + candidate-bounded executor.
 *
 *   parseScryfallSearch(raw) → SearchAST    (no DB, no side effects)
 *   executeSearch(ast, candidateIds)        (SQLite, bounded by collection IDs)
 *
 * Supported tokens:
 *   name:/n:          name substring          (: or =)
 *   t:/type:          type-line substring      (: or =)
 *   o:/oracle:        oracle-text substring    (: or =)
 *   mv:/cmc:          mana value               (: = >= <= > <)
 *   s:/set:/e:        set code                 (: or =)
 *   cn:/number:       collector number         (: or =)
 *   r:/rarity:        rarity                   (: or =)
 *   c:/color:         color                    (: or = → exact; <= subset; >= superset)
 *   ci:/id:/identity: color identity           (same operators)
 *   otag:/oracle-tag:  Scryfall Oracle tag      (: or =)
 *   sort:/order:      name | set | mv | price | edhrec    (: or =, cannot be negated)
 *   direction:        asc | desc               (: or =, cannot be negated)
 *   Leading - negates any token except sort/order/direction.
 *
 * Token parsing rules:
 *   - ANY text matching the token regex is consumed from bare-text,
 *     whether or not the token is valid.
 *   - Invalid tokens produce structured ValidationError entries.
 *   - They do NOT also appear in nameTerms.
 */

import { openDb, CacheNotReadyError } from './db/scryfall-sqlite';
import type Database from 'better-sqlite3';

export { CacheNotReadyError };

// ── AST types ─────────────────────────────────────────────────────────────────

export type SortField = 'name' | 'set' | 'mv' | 'price' | 'edhrec';

export interface ValidationError {
	token: string;
	message: string;
}

export interface NameFilter {
	kind: 'name';
	value: string;
	mode: 'contains' | 'exact' | 'regex';
	negate: boolean;
}
export interface TypeFilter {
	kind: 'type';
	value: string;
	mode?: 'contains' | 'regex';
	negate: boolean;
}
export interface OracleFilter {
	kind: 'oracle';
	value: string;
	mode?: 'contains' | 'regex';
	negate: boolean;
}
export interface MvFilter {
	kind: 'mv';
	op: '=' | '>=' | '<=' | '>' | '<';
	val: number;
	negate: boolean;
}
export interface SetFilter {
	kind: 'set';
	value: string;
	negate: boolean;
}
export interface CnFilter {
	kind: 'cn';
	op?: '>=' | '<=' | '>' | '<';
	value: string;
	negate: boolean;
}
export interface RarityFilter {
	kind: 'rarity';
	op?: '>=' | '<=' | '>' | '<';
	value: string;
	negate: boolean;
}
export interface PriceFilter {
	kind: 'price';
	op: '=' | '>=' | '<=' | '>' | '<';
	val: number;
	negate: boolean;
}
export interface LegalityFilter {
	kind: 'legality';
	format: string;
	status: 'legal' | 'banned' | 'restricted';
	negate: boolean;
}
export interface StatFilter {
	kind: 'stat';
	field: 'power' | 'toughness' | 'loyalty';
	op: '=' | '>=' | '<=' | '>' | '<';
	value: string;
	negate: boolean;
}
export interface KeywordFilter {
	kind: 'keyword';
	value: string;
	negate: boolean;
}
export interface ProducesFilter {
	kind: 'produces';
	chars: string[];
	negate: boolean;
}
export interface TextMetadataFilter {
	kind: 'textMetadata';
	field: 'artist' | 'flavor_text' | 'watermark';
	value: string;
	mode?: 'contains' | 'regex';
	negate: boolean;
}
export interface DateFilter {
	kind: 'date';
	field: 'released_at' | 'year';
	op: '=' | '>=' | '<=' | '>' | '<';
	value: string;
	negate: boolean;
}
export interface PrintingMetadataFilter {
	kind: 'printingMetadata';
	field:
		| 'lang'
		| 'game'
		| 'finish'
		| 'frame'
		| 'layout'
		| 'setType'
		| 'borderColor'
		| 'securityStamp';
	value: string;
	negate: boolean;
}
export interface InFilter {
	kind: 'in';
	value: string;
	negate: boolean;
}
export interface IsFilter {
	kind: 'is';
	value: string;
	negate: boolean;
}
export interface HasFilter {
	kind: 'has';
	value: string;
	negate: boolean;
}
export interface OracleTagFilter {
	kind: 'oracleTag';
	value: string;
	negate: boolean;
}
/** Color filter. chars = WUBRG letters only; colorless = true if C was in the input. */
export interface ColorFilter {
	kind: 'color';
	chars: string[];
	colorless: boolean;
	op: '=' | '<=' | '>=';
	negate: boolean;
}
export interface IdentityFilter {
	kind: 'identity';
	chars: string[];
	colorless: boolean;
	op: '=' | '<=' | '>=';
	negate: boolean;
}

export type FilterNode =
	| NameFilter
	| TypeFilter
	| OracleFilter
	| MvFilter
	| SetFilter
	| CnFilter
	| RarityFilter
	| PriceFilter
	| LegalityFilter
	| StatFilter
	| KeywordFilter
	| ProducesFilter
	| TextMetadataFilter
	| DateFilter
	| PrintingMetadataFilter
	| InFilter
	| IsFilter
	| HasFilter
	| ColorFilter
	| IdentityFilter
	| OracleTagFilter;

export type SearchExpression =
	| { kind: 'term'; filter: FilterNode }
	| { kind: 'and' | 'or'; children: SearchExpression[] }
	| { kind: 'not'; child: SearchExpression };

export interface SearchAST {
	/** Bare text tokens and name:/n: tokens handled by collection-database name conditions. */
	nameTerms: Array<{ value: string; negate: boolean }>;
	filters: FilterNode[];
	expression: SearchExpression | null;
	/** True when nameTerms can be safely applied as a collection-database AND pre-filter. */
	useDatabaseNameTerms: boolean;
	/** True when matching requires the local Scryfall executor. */
	requiresExecutor: boolean;
	sort: SortField;
	direction: 'asc' | 'desc';
	errors: ValidationError[];
}

// ── Color name map ────────────────────────────────────────────────────────────

const COLOR_NAME_MAP: Record<string, string> = {
	white: 'W',
	blue: 'U',
	black: 'B',
	red: 'R',
	green: 'G',
	colorless: 'C'
};

const LANGUAGE_NAME_MAP: Record<string, string> = {
	english: 'en',
	spanish: 'es',
	french: 'fr',
	german: 'de',
	italian: 'it',
	portuguese: 'pt',
	japanese: 'ja',
	korean: 'ko',
	russian: 'ru',
	chinese: 'zhs',
	'traditional-chinese': 'zht',
	hebrew: 'he',
	latin: 'la',
	greek: 'grc',
	arabic: 'ar',
	sanskrit: 'sa',
	phyrexian: 'ph'
};

const IS_ALIASES: Record<string, string> = {
	brawlcommander: 'brawler',
	fullart: 'full',
	planeswalkerdeck: 'planeswalker_deck',
	intropack: 'intro_pack',
	extended: 'extendedart',
	rebalanced: 'alchemy'
};

const SUPPORTED_IS = new Set([
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
]);

const HAS_ALIASES: Record<string, string> = {
	multiface: 'multifaced',
	security: 'securitystamp',
	stamp: 'securitystamp',
	powerandtoughness: 'pt'
};

const SUPPORTED_HAS = new Set([
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
]);

function parseColorString(raw: string): {
	chars: string[];
	colorless: boolean;
	unknowns: string[];
} {
	const lower = raw.toLowerCase();
	const chars: string[] = [];
	const unknowns: string[] = [];
	let colorless = false;

	// Full color name as the entire token
	if (COLOR_NAME_MAP[lower]) {
		const ch = COLOR_NAME_MAP[lower];
		if (ch === 'C') colorless = true;
		else chars.push(ch);
		return { chars, colorless, unknowns };
	}

	// Comma-separated full names or letter sequence
	const parts = raw
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);
	for (const part of parts) {
		const pl = part.toLowerCase();
		if (COLOR_NAME_MAP[pl]) {
			const ch = COLOR_NAME_MAP[pl];
			if (ch === 'C') {
				if (!colorless) colorless = true;
			} else if (!chars.includes(ch)) chars.push(ch);
		} else {
			for (const letter of part.toUpperCase()) {
				if ('WUBRG'.includes(letter)) {
					if (!chars.includes(letter)) chars.push(letter);
				} else if (letter === 'C') {
					if (!colorless) colorless = true;
				} else {
					if (!unknowns.includes(letter)) unknowns.push(letter);
				}
			}
		}
	}

	return { chars, colorless, unknowns };
}

// Fields that only accept : or =
const COLON_ONLY_FIELDS = new Set([
	'name',
	'n',
	't',
	'type',
	'o',
	'oracle',
	's',
	'set',
	'e',
	'otag',
	'oracle-tag',
	'oracletag',
	'function',
	'f',
	'format',
	'legal',
	'banned',
	'restricted',
	'kw',
	'keyword',
	'produces',
	'a',
	'artist',
	'ft',
	'flavor',
	'wm',
	'watermark',
	'lang',
	'language',
	'game',
	'finish',
	'frame',
	'layout',
	'st',
	'settype',
	'border',
	'stamp',
	'security',
	'in',
	'is',
	'not',
	'has'
]);
// Fields that cannot be negated
const NON_NEGATABLE = new Set(['sort', 'order', 'direction']);

// ── Pure parser ───────────────────────────────────────────────────────────────

type QueryToken =
	| { kind: 'atom'; raw: string }
	| { kind: 'lparen' | 'rparen' | 'or' | 'not'; raw: string };

function tokenize(raw: string, errors: ValidationError[]): QueryToken[] {
	const tokens: QueryToken[] = [];
	let i = 0;
	while (i < raw.length) {
		if (/\s/.test(raw[i])) {
			i++;
			continue;
		}
		if (raw[i] === '(' || raw[i] === ')') {
			tokens.push({ kind: raw[i] === '(' ? 'lparen' : 'rparen', raw: raw[i] });
			i++;
			continue;
		}
		if (raw[i] === '-' && raw[i + 1] === '(') {
			tokens.push({ kind: 'not', raw: '-' });
			i++;
			continue;
		}

		const start = i;
		let quote = false;
		let regex = false;
		let escaped = false;
		while (i < raw.length) {
			const ch = raw[i];
			if (escaped) {
				escaped = false;
				i++;
				continue;
			}
			if ((quote || regex) && ch === '\\') {
				escaped = true;
				i++;
				continue;
			}
			if (!regex && ch === '"') {
				quote = !quote;
				i++;
				continue;
			}
			if (!quote && ch === '/') {
				regex = !regex;
				i++;
				continue;
			}
			if (!quote && !regex && (/\s/.test(ch) || ch === '(' || ch === ')')) break;
			i++;
		}
		const atom = raw.slice(start, i);
		if (quote) errors.push({ token: atom, message: 'Unclosed quoted string' });
		if (regex) errors.push({ token: atom, message: 'Unclosed regular expression' });
		if (/^OR$/i.test(atom)) tokens.push({ kind: 'or', raw: atom });
		else if (atom) tokens.push({ kind: 'atom', raw: atom });
	}
	return tokens;
}

function decodeValue(raw: string): { value: string; mode: 'contains' | 'regex' } {
	if (raw.startsWith('"') && raw.endsWith('"')) {
		return { value: raw.slice(1, -1).replace(/\\"/g, '"'), mode: 'contains' };
	}
	if (raw.startsWith('/') && raw.endsWith('/') && raw.length >= 2) {
		return { value: raw.slice(1, -1), mode: 'regex' };
	}
	return { value: raw, mode: 'contains' };
}

function addLeaf(ast: SearchAST, filter: FilterNode): SearchExpression {
	if (filter.kind === 'name') {
		if (filter.mode === 'contains') {
			ast.nameTerms.push({ value: filter.value, negate: filter.negate });
		}
	} else {
		ast.filters.push(filter);
	}
	return { kind: 'term', filter };
}

function parseAtom(ast: SearchAST, token: string): SearchExpression | null {
	let negate = false;
	let raw = token;
	if (raw.startsWith('-') && raw.length > 1) {
		negate = true;
		raw = raw.slice(1);
	}

	if (raw.startsWith('!')) {
		const decoded = decodeValue(raw.slice(1));
		if (!decoded.value) {
			ast.errors.push({ token, message: 'Exact-name search requires a card name' });
			return null;
		}
		return addLeaf(ast, { kind: 'name', value: decoded.value, mode: 'exact', negate });
	}

	const match = raw.match(/^([a-z][a-z-]*)(>=|<=|>|<|=|:)(.+)$/i);
	if (!match) {
		const decoded = decodeValue(raw);
		if (decoded.mode === 'regex') {
			try {
				new RegExp(decoded.value, 'i');
			} catch {
				ast.errors.push({ token, message: 'Invalid regular expression' });
				return null;
			}
		}
		return addLeaf(ast, { kind: 'name', value: decoded.value, mode: decoded.mode, negate });
	}

	const field = match[1].toLowerCase();
	const opStr = match[2];
	const decoded = decodeValue(match[3]);
	const rawVal = decoded.value;

	if (decoded.mode === 'regex') {
		try {
			new RegExp(rawVal, 'i');
		} catch {
			ast.errors.push({ token, message: 'Invalid regular expression' });
			return null;
		}
		if (
			![
				'name',
				'n',
				't',
				'type',
				'o',
				'oracle',
				'a',
				'artist',
				'ft',
				'flavor',
				'wm',
				'watermark'
			].includes(field)
		) {
			ast.errors.push({ token, message: `${field}: does not support regular expressions` });
			return null;
		}
	}

	if (NON_NEGATABLE.has(field) && negate) {
		ast.errors.push({ token, message: `${field}: cannot be negated` });
		return null;
	}
	if (COLON_ONLY_FIELDS.has(field) && opStr !== ':' && opStr !== '=') {
		ast.errors.push({
			token,
			message: `${field}: does not support operator "${opStr}". Use : or =`
		});
		return null;
	}

	let filter: FilterNode | null = null;
	switch (field) {
		case 'name':
		case 'n':
			filter = { kind: 'name', value: rawVal, mode: decoded.mode, negate };
			break;

		case 't':
		case 'type':
			filter = {
				kind: 'type',
				value: rawVal,
				...(decoded.mode === 'regex' ? { mode: 'regex' as const } : {}),
				negate
			};
			break;

		case 'o':
		case 'oracle':
			filter = {
				kind: 'oracle',
				value: rawVal,
				...(decoded.mode === 'regex' ? { mode: 'regex' as const } : {}),
				negate
			};
			break;

		case 'mv':
		case 'cmc': {
			// : and = both mean exact equality
			const op: MvFilter['op'] = opStr === ':' || opStr === '=' ? '=' : (opStr as MvFilter['op']);
			const val = parseFloat(rawVal);
			if (isNaN(val)) {
				ast.errors.push({ token, message: `mv: expected a number, got "${rawVal}"` });
			} else {
				filter = { kind: 'mv', op, val, negate };
			}
			break;
		}

		case 's':
		case 'set':
		case 'e':
			filter = { kind: 'set', value: rawVal.toLowerCase(), negate };
			break;

		case 'cn':
		case 'number': {
			filter = {
				kind: 'cn',
				...(opStr === ':' || opStr === '=' ? {} : { op: opStr as NonNullable<CnFilter['op']> }),
				value: rawVal,
				negate
			};
			break;
		}

		case 'r':
		case 'rarity': {
			const rar = rawVal.toLowerCase();
			const rarMap: Record<string, string> = { c: 'common', u: 'uncommon', r: 'rare', m: 'mythic' };
			const resolved = rarMap[rar] ?? rar;
			if (!['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'].includes(resolved)) {
				ast.errors.push({
					token,
					message: `Unknown rarity "${rawVal}". Valid: common, uncommon, rare, mythic, special, bonus`
				});
			} else {
				filter = {
					kind: 'rarity',
					...(opStr === ':' || opStr === '='
						? {}
						: { op: opStr as NonNullable<RarityFilter['op']> }),
					value: resolved,
					negate
				};
			}
			break;
		}

		case 'otag':
		case 'oracle-tag':
		case 'oracletag':
		case 'function': {
			const value = rawVal.trim();
			if (!value) {
				ast.errors.push({ token, message: `${field}: requires a tag label` });
			} else {
				filter = { kind: 'oracleTag', value, negate };
			}
			break;
		}

		case 'usd': {
			const val = parseFloat(rawVal);
			if (isNaN(val)) {
				ast.errors.push({ token, message: `usd: expected a number, got "${rawVal}"` });
			} else {
				const op: PriceFilter['op'] =
					opStr === ':' || opStr === '=' ? '=' : (opStr as PriceFilter['op']);
				filter = { kind: 'price', op, val, negate };
			}
			break;
		}

		case 'f':
		case 'format':
		case 'legal':
			filter = {
				kind: 'legality',
				format: rawVal.toLowerCase(),
				status: 'legal',
				negate
			};
			break;

		case 'banned':
		case 'restricted':
			filter = {
				kind: 'legality',
				format: rawVal.toLowerCase(),
				status: field,
				negate
			};
			break;

		case 'pow':
		case 'power':
		case 'tou':
		case 'toughness':
		case 'loy':
		case 'loyalty': {
			const statField: StatFilter['field'] =
				field === 'pow' || field === 'power'
					? 'power'
					: field === 'tou' || field === 'toughness'
						? 'toughness'
						: 'loyalty';
			const op: StatFilter['op'] =
				opStr === ':' || opStr === '=' ? '=' : (opStr as StatFilter['op']);
			if (op !== '=' && !Number.isFinite(Number(rawVal))) {
				ast.errors.push({
					token,
					message: `${field}: comparison operators require a numeric value`
				});
			} else {
				filter = { kind: 'stat', field: statField, op, value: rawVal, negate };
			}
			break;
		}

		case 'kw':
		case 'keyword':
			filter = { kind: 'keyword', value: rawVal, negate };
			break;

		case 'produces': {
			const { chars, colorless, unknowns } = parseColorString(rawVal);
			if (unknowns.length > 0) {
				ast.errors.push({
					token,
					message: `Unknown produced-mana color(s): ${unknowns.join(', ')}`
				});
			} else {
				filter = {
					kind: 'produces',
					chars: [...chars, ...(colorless ? ['C'] : [])],
					negate
				};
			}
			break;
		}

		case 'a':
		case 'artist':
		case 'ft':
		case 'flavor':
		case 'wm':
		case 'watermark': {
			const metadataField: TextMetadataFilter['field'] =
				field === 'a' || field === 'artist'
					? 'artist'
					: field === 'ft' || field === 'flavor'
						? 'flavor_text'
						: 'watermark';
			filter = {
				kind: 'textMetadata',
				field: metadataField,
				value: rawVal,
				...(decoded.mode === 'regex' ? { mode: 'regex' as const } : {}),
				negate
			};
			break;
		}

		case 'date':
		case 'released':
		case 'year': {
			const dateField: DateFilter['field'] = field === 'year' ? 'year' : 'released_at';
			const op: DateFilter['op'] =
				opStr === ':' || opStr === '=' ? '=' : (opStr as DateFilter['op']);
			const valid =
				dateField === 'year'
					? /^\d{4}$/.test(rawVal)
					: /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(rawVal);
			if (!valid) {
				ast.errors.push({
					token,
					message:
						dateField === 'year'
							? 'year: expects a four-digit year'
							: 'date: expects YYYY, YYYY-MM, or YYYY-MM-DD'
				});
			} else {
				filter = { kind: 'date', field: dateField, op, value: rawVal, negate };
			}
			break;
		}

		case 'lang':
		case 'language': {
			const value = LANGUAGE_NAME_MAP[rawVal.toLowerCase()] ?? rawVal.toLowerCase();
			filter = { kind: 'printingMetadata', field: 'lang', value, negate };
			break;
		}

		case 'game': {
			const value = rawVal.toLowerCase();
			if (!['paper', 'arena', 'mtgo'].includes(value)) {
				ast.errors.push({
					token,
					message: `Unknown game "${rawVal}". Valid: paper, arena, mtgo`
				});
			} else {
				filter = { kind: 'printingMetadata', field: 'game', value, negate };
			}
			break;
		}

		case 'finish': {
			const value = rawVal.toLowerCase() === 'regular' ? 'nonfoil' : rawVal.toLowerCase();
			if (!['nonfoil', 'foil', 'etched', 'glossy'].includes(value)) {
				ast.errors.push({
					token,
					message: `Unknown finish "${rawVal}". Valid: nonfoil, foil, etched, glossy`
				});
			} else {
				filter = { kind: 'printingMetadata', field: 'finish', value, negate };
			}
			break;
		}

		case 'frame': {
			const value = rawVal.toLowerCase();
			if (!['1993', '1997', '2003', '2015', 'future'].includes(value)) {
				ast.errors.push({
					token,
					message: `Unknown frame "${rawVal}". Valid: 1993, 1997, 2003, 2015, future`
				});
			} else {
				filter = { kind: 'printingMetadata', field: 'frame', value, negate };
			}
			break;
		}

		case 'layout':
			filter = {
				kind: 'printingMetadata',
				field: 'layout',
				value: rawVal.toLowerCase(),
				negate
			};
			break;

		case 'st':
		case 'settype':
			filter = {
				kind: 'printingMetadata',
				field: 'setType',
				value: rawVal.toLowerCase(),
				negate
			};
			break;

		case 'border':
			filter = {
				kind: 'printingMetadata',
				field: 'borderColor',
				value: rawVal.toLowerCase(),
				negate
			};
			break;

		case 'stamp':
		case 'security':
			filter = {
				kind: 'printingMetadata',
				field: 'securityStamp',
				value: rawVal.toLowerCase(),
				negate
			};
			break;

		case 'in':
			filter = { kind: 'in', value: rawVal.toLowerCase(), negate };
			break;

		case 'is':
		case 'not': {
			const rawProperty = rawVal.toLowerCase().replace(/-/g, '_');
			const value = IS_ALIASES[rawProperty] ?? rawProperty;
			if (!SUPPORTED_IS.has(value)) {
				ast.errors.push({
					token,
					message: `Unsupported is: property "${rawVal}"`
				});
			} else {
				filter = {
					kind: 'is',
					value,
					negate: field === 'not' ? !negate : negate
				};
			}
			break;
		}

		case 'has': {
			const rawProperty = rawVal.toLowerCase().replace(/-/g, '');
			const value = HAS_ALIASES[rawProperty] ?? rawProperty;
			if (!SUPPORTED_HAS.has(value)) {
				ast.errors.push({
					token,
					message: `Unsupported has: property "${rawVal}"`
				});
			} else {
				filter = { kind: 'has', value, negate };
			}
			break;
		}

		case 'c':
		case 'color': {
			if (opStr === '>' || opStr === '<') {
				ast.errors.push({
					token,
					message: `color: strict operators > < not supported. Use <= or >=`
				});
				break;
			}
			const colorOp: '=' | '<=' | '>=' = opStr === '<=' ? '<=' : opStr === '>=' ? '>=' : '=';
			const { chars, colorless, unknowns } = parseColorString(rawVal);
			if (unknowns.length > 0) {
				ast.errors.push({ token, message: `Unknown color letter(s): ${unknowns.join(', ')}` });
			} else if (chars.length === 0 && !colorless) {
				ast.errors.push({ token, message: `color: requires at least one color` });
			} else if (colorless && chars.length > 0) {
				ast.errors.push({ token, message: `Colorless (C) cannot be combined with other colors` });
			} else {
				filter = { kind: 'color', chars, colorless, op: colorOp, negate };
			}
			break;
		}

		case 'ci':
		case 'id':
		case 'identity': {
			if (opStr === '>' || opStr === '<') {
				ast.errors.push({
					token,
					message: `identity: strict operators > < not supported. Use <= or >=`
				});
				break;
			}
			const idOp: '=' | '<=' | '>=' = opStr === '<=' ? '<=' : opStr === '>=' ? '>=' : '=';
			const { chars, colorless, unknowns } = parseColorString(rawVal);
			if (unknowns.length > 0) {
				ast.errors.push({ token, message: `Unknown color letter(s): ${unknowns.join(', ')}` });
			} else if (chars.length === 0 && !colorless) {
				ast.errors.push({ token, message: `identity: requires at least one color` });
			} else if (colorless && chars.length > 0) {
				ast.errors.push({ token, message: `Colorless (C) cannot be combined with other colors` });
			} else {
				filter = { kind: 'identity', chars, colorless, op: idOp, negate };
			}
			break;
		}

		case 'sort':
		case 'order':
			switch (rawVal.toLowerCase()) {
				case 'name':
					ast.sort = 'name';
					break;
				case 'set':
					ast.sort = 'set';
					break;
				case 'mv':
				case 'cmc':
					ast.sort = 'mv';
					break;
				case 'price':
					ast.sort = 'price';
					break;
				case 'edhrec':
					ast.sort = 'edhrec';
					break;
				default:
					ast.errors.push({
						token,
						message: `Unknown sort field "${rawVal}". Valid: name, set, mv, price, edhrec`
					});
			}
			return null;

		case 'direction':
			switch (rawVal.toLowerCase()) {
				case 'asc':
					ast.direction = 'asc';
					break;
				case 'desc':
					ast.direction = 'desc';
					break;
				default:
					ast.errors.push({ token, message: `Unknown direction "${rawVal}". Valid: asc, desc` });
			}
			return null;

		default:
			ast.errors.push({ token, message: `Unknown search field "${field}"` });
			return null;
	}
	return filter ? addLeaf(ast, filter) : null;
}

function isFlatAnd(expression: SearchExpression | null): boolean {
	if (!expression) return true;
	if (expression.kind === 'term') return true;
	return expression.kind === 'and' && expression.children.every((child) => child.kind === 'term');
}

export function parseScryfallSearch(raw: string): SearchAST {
	const ast: SearchAST = {
		nameTerms: [],
		filters: [],
		expression: null,
		useDatabaseNameTerms: true,
		requiresExecutor: false,
		sort: 'name',
		direction: 'asc',
		errors: []
	};
	const tokens = tokenize(raw, ast.errors);
	let index = 0;

	function combine(
		kind: 'and' | 'or',
		left: SearchExpression | null,
		right: SearchExpression | null
	) {
		if (!left) return right;
		if (!right) return left;
		const children = left.kind === kind ? [...left.children, right] : [left, right];
		return { kind, children } as SearchExpression;
	}

	function parsePrimary(): SearchExpression | null {
		const token = tokens[index];
		if (!token) return null;
		if (token.kind === 'not') {
			index++;
			const child = parsePrimary();
			if (!child)
				ast.errors.push({ token: token.raw, message: 'Negation requires a search expression' });
			return child ? { kind: 'not', child } : null;
		}
		if (token.kind === 'lparen') {
			index++;
			const child = parseOr();
			if (tokens[index]?.kind === 'rparen') index++;
			else ast.errors.push({ token: token.raw, message: 'Unclosed parenthesis' });
			return child;
		}
		if (token.kind === 'rparen' || token.kind === 'or') return null;
		index++;
		return parseAtom(ast, token.raw);
	}

	function parseAnd(): SearchExpression | null {
		let expression = parsePrimary();
		while (
			index < tokens.length &&
			tokens[index].kind !== 'or' &&
			tokens[index].kind !== 'rparen'
		) {
			expression = combine('and', expression, parsePrimary());
		}
		return expression;
	}

	function parseOr(): SearchExpression | null {
		let expression = parseAnd();
		while (tokens[index]?.kind === 'or') {
			const token = tokens[index++];
			const right = parseAnd();
			if (!right)
				ast.errors.push({ token: token.raw, message: 'OR requires an expression on both sides' });
			expression = combine('or', expression, right);
		}
		return expression;
	}

	ast.expression = parseOr();
	while (index < tokens.length) {
		ast.errors.push({
			token: tokens[index].raw,
			message: `Unexpected token "${tokens[index].raw}"`
		});
		index++;
	}

	const flatAnd = isFlatAnd(ast.expression);
	const nameLeaves = ast.nameTerms.length;
	const hasComplexName = (() => {
		const visit = (node: SearchExpression | null): boolean => {
			if (!node) return false;
			if (node.kind === 'term')
				return node.filter.kind === 'name' && node.filter.mode !== 'contains';
			if (node.kind === 'not') return visit(node.child);
			return node.children.some(visit);
		};
		return visit(ast.expression);
	})();
	ast.useDatabaseNameTerms = flatAnd && !hasComplexName;
	ast.requiresExecutor =
		ast.filters.length > 0 ||
		!ast.useDatabaseNameTerms ||
		(nameLeaves === 0 && ast.expression !== null);
	return ast;
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

function escapeLike(s: string): string {
	return s.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function negateComparisonOp(op: '=' | '>=' | '<=' | '>' | '<'): string {
	switch (op) {
		case '=':
			return '!=';
		case '>=':
			return '<';
		case '<=':
			return '>';
		case '>':
			return '<=';
		case '<':
			return '>=';
	}
}

/**
 * Build SQL condition + args for a color or identity filter.
 *
 * NULL semantics: both positive and negative filters require the column to be non-null.
 * Exact (=): card's set == given set
 * Subset (<=): card's colors ⊆ given
 * Superset (>=): card's colors ⊇ given
 * Colorless = empty array (NOT null).
 */
function buildColorSql(
	col: 'colors' | 'color_identity',
	chars: string[],
	colorless: boolean,
	op: '=' | '<=' | '>=',
	negate: boolean
): { sql: string; args: (string | number)[] } {
	const args: (string | number)[] = [];
	let inner: string;

	if (colorless) {
		inner = op === '>=' ? '1=1' : `json_array_length(${col}) = 0`;
	} else if (op === '=') {
		const exists = chars
			.map(() => `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`)
			.join(' AND ');
		inner = `json_array_length(${col}) = ${chars.length} AND ${exists}`;
		args.push(...chars);
	} else if (op === '<=') {
		const placeholders = chars.map(() => '?').join(', ');
		inner = `NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE value NOT IN (${placeholders}))`;
		args.push(...chars);
	} else {
		// >= superset
		const exists = chars
			.map(() => `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`)
			.join(' AND ');
		inner = exists;
		args.push(...chars);
	}

	const notNull = `${col} IS NOT NULL`;
	let sql: string;
	if (negate) {
		sql = inner === '1=1' ? `(${notNull} AND 0=1)` : `(${notNull} AND NOT (${inner}))`;
	} else {
		sql = inner === '1=1' ? `(${notNull})` : `(${notNull} AND ${inner})`;
	}

	return { sql, args };
}

export type SharedOracleTagIndex = Map<string, Set<string>>;

type SqlFragment = {
	sql: string;
	args: (string | number)[];
};

function metadataBoolean(path: string): SqlFragment {
	return {
		sql: `COALESCE(json_extract(printing_metadata, '${path}'), 0) = 1`,
		args: []
	};
}

function metadataArrayContains(path: string, value: string): SqlFragment {
	return {
		sql: `EXISTS (
			SELECT 1 FROM json_each(printing_metadata, '${path}')
			WHERE lower(value) = lower(?)
		)`,
		args: [value]
	};
}

function buildIsPredicate(value: string): SqlFragment {
	const layout = (name: string): SqlFragment => ({
		sql: `lower(json_extract(printing_metadata, '$.layout')) = ?`,
		args: [name]
	});
	const frameEffect = (name: string) => metadataArrayContains('$.frameEffects', name);
	const promoType = (name: string) => metadataArrayContains('$.promoTypes', name);

	switch (value) {
		case 'commander':
		case 'duelcommander':
			return {
				sql: `(
					lower(type_line) LIKE '%legendary%creature%'
					OR lower(COALESCE(oracle_text, '')) LIKE '%can be your commander%'
					OR lower(type_line) LIKE '%legendary%background%'
				)`,
				args: []
			};
		case 'brawler':
			return {
				sql: `(
					lower(type_line) LIKE '%legendary%creature%'
					OR lower(type_line) LIKE '%legendary%planeswalker%'
				)`,
				args: []
			};
		case 'oathbreaker':
			return { sql: `lower(type_line) LIKE '%planeswalker%'`, args: [] };
		case 'companion':
			return {
				sql: `EXISTS (
					SELECT 1 FROM json_each(keywords)
					WHERE lower(value) = 'companion'
				)`,
				args: []
			};
		case 'gamechanger':
			return metadataBoolean('$.gameChanger');
		case 'reserved':
			return metadataBoolean('$.reserved');
		case 'hybrid':
			return {
				sql: `regexp('\\{(?:[WUBRGC2]/[WUBRGC])\\}', mana_cost)`,
				args: []
			};
		case 'phyrexian':
			return { sql: `regexp('\\{(?:[WUBRGC]/P|P/[WUBRGC])\\}', mana_cost)`, args: [] };
		case 'split':
			return layout('split');
		case 'flip':
			return layout('flip');
		case 'transform':
			return layout('transform');
		case 'meld':
			return layout('meld');
		case 'leveler':
			return {
				sql: `EXISTS (
					SELECT 1 FROM json_each(keywords)
					WHERE lower(value) = 'level up'
				)`,
				args: []
			};
		case 'dfc':
			return {
				sql: `lower(json_extract(printing_metadata, '$.layout'))
					IN ('transform', 'modal_dfc', 'reversible_card')`,
				args: []
			};
		case 'mdfc':
			return layout('modal_dfc');
		case 'spell':
			return {
				sql: `lower(type_line) LIKE '%artifact%'
					OR lower(type_line) LIKE '%battle%'
					OR lower(type_line) LIKE '%creature%'
					OR lower(type_line) LIKE '%enchantment%'
					OR lower(type_line) LIKE '%instant%'
					OR lower(type_line) LIKE '%kindred%'
					OR lower(type_line) LIKE '%planeswalker%'
					OR lower(type_line) LIKE '%sorcery%'`,
				args: []
			};
		case 'permanent':
			return {
				sql: `lower(type_line) LIKE '%artifact%'
					OR lower(type_line) LIKE '%battle%'
					OR lower(type_line) LIKE '%creature%'
					OR lower(type_line) LIKE '%enchantment%'
					OR lower(type_line) LIKE '%land%'
					OR lower(type_line) LIKE '%planeswalker%'`,
				args: []
			};
		case 'historic':
			return {
				sql: `lower(type_line) LIKE '%artifact%'
					OR lower(type_line) LIKE '%legendary%'
					OR lower(type_line) LIKE '%saga%'`,
				args: []
			};
		case 'party':
			return {
				sql: `lower(type_line) LIKE '%cleric%'
					OR lower(type_line) LIKE '%rogue%'
					OR lower(type_line) LIKE '%warrior%'
					OR lower(type_line) LIKE '%wizard%'`,
				args: []
			};
		case 'modal':
			return {
				sql: `lower(COALESCE(oracle_text, '')) LIKE '%choose one%'
					OR lower(COALESCE(oracle_text, '')) LIKE '%choose two%'
					OR lower(COALESCE(oracle_text, '')) LIKE '%choose three%'`,
				args: []
			};
		case 'vanilla':
			return {
				sql: `lower(type_line) LIKE '%creature%'
					AND trim(COALESCE(oracle_text, '')) = ''`,
				args: []
			};
		case 'frenchvanilla':
			return {
				sql: `lower(type_line) LIKE '%creature%'
					AND is_french_vanilla(oracle_text, keywords) = 1`,
				args: []
			};
		case 'funny':
			return {
				sql: `lower(json_extract(printing_metadata, '$.borderColor')) = 'silver'
					OR lower(json_extract(printing_metadata, '$.securityStamp')) = 'acorn'
					OR lower(json_extract(printing_metadata, '$.setType')) = 'funny'`,
				args: []
			};
		case 'booster':
			return metadataBoolean('$.booster');
		case 'planeswalker_deck':
			return promoType('planeswalkerdeck');
		case 'league':
			return promoType('league');
		case 'buyabox':
			return promoType('buyabox');
		case 'giftbox':
			return promoType('giftbox');
		case 'intro_pack':
			return promoType('intropack');
		case 'gameday':
			return promoType('gameday');
		case 'prerelease':
			return promoType('prerelease');
		case 'release':
			return promoType('release');
		case 'datestamped':
			return promoType('datestamped');
		case 'full':
			return {
				sql: `COALESCE(json_extract(printing_metadata, '$.fullArt'), 0) = 1
					OR EXISTS (
						SELECT 1 FROM json_each(printing_metadata, '$.frameEffects')
						WHERE lower(value) = 'fullart'
					)`,
				args: []
			};
		case 'nonfoil':
			return metadataArrayContains('$.finishes', 'nonfoil');
		case 'foil':
			return metadataArrayContains('$.finishes', 'foil');
		case 'etched':
			return metadataArrayContains('$.finishes', 'etched');
		case 'glossy':
			return metadataArrayContains('$.finishes', 'glossy');
		case 'hires':
			return metadataBoolean('$.highresImage');
		case 'new':
			return {
				sql: `json_extract(printing_metadata, '$.frame') = '2015'`,
				args: []
			};
		case 'old':
			return {
				sql: `json_extract(printing_metadata, '$.frame') IN ('1993', '1997')`,
				args: []
			};
		case 'digital':
			return metadataBoolean('$.digital');
		case 'promo':
			return metadataBoolean('$.promo');
		case 'spotlight':
			return metadataBoolean('$.storySpotlight');
		case 'scryfallpreview':
			return {
				sql: `lower(json_extract(printing_metadata, '$.previewSource')) = 'scryfall'`,
				args: []
			};
		case 'reprint':
			return metadataBoolean('$.reprint');
		case 'unique':
			return {
				sql: `oracle_id IS NOT NULL AND (
					SELECT COUNT(DISTINCT sibling.set_code)
					FROM scryfall_cache sibling
					WHERE sibling.oracle_id = scryfall_cache.oracle_id
				) = 1`,
				args: []
			};
		case 'masterpiece':
			return {
				sql: `lower(json_extract(printing_metadata, '$.setType')) = 'masterpiece'`,
				args: []
			};
		case 'colorshifted':
			return frameEffect('colorshifted');
		case 'oversized':
			return metadataBoolean('$.oversized');
		case 'textless':
			return metadataBoolean('$.textless');
		case 'variation':
			return metadataBoolean('$.variation');
		case 'borderless':
			return {
				sql: `lower(json_extract(printing_metadata, '$.borderColor')) = 'borderless'`,
				args: []
			};
		case 'boosterfun':
			return promoType('boosterfun');
		case 'showcase':
			return frameEffect('showcase');
		case 'extendedart':
			return frameEffect('extendedart');
		case 'alchemy':
			return {
				sql: `EXISTS (
					SELECT 1 FROM json_each(printing_metadata, '$.promoTypes')
					WHERE lower(value) IN ('alchemy', 'rebalanced')
				)`,
				args: []
			};
		case 'universesbeyond':
			return {
				sql: `lower(json_extract(printing_metadata, '$.securityStamp')) = 'triangle'`,
				args: []
			};
		default:
			return { sql: '0=1', args: [] };
	}
}

function buildHasPredicate(value: string): SqlFragment {
	switch (value) {
		case 'indicator':
			return {
				sql: `json_array_length(
					json_extract(printing_metadata, '$.colorIndicator')
				) > 0`,
				args: []
			};
		case 'watermark':
			return { sql: `watermark IS NOT NULL AND watermark != ''`, args: [] };
		case 'foil':
			return metadataArrayContains('$.finishes', 'foil');
		case 'nonfoil':
			return metadataArrayContains('$.finishes', 'nonfoil');
		case 'promo':
			return metadataBoolean('$.promo');
		case 'colors':
			return { sql: `json_array_length(colors) > 0`, args: [] };
		case 'flavor':
			return { sql: `flavor_text IS NOT NULL AND flavor_text != ''`, args: [] };
		case 'oracle':
			return { sql: `oracle_text IS NOT NULL AND oracle_text != ''`, args: [] };
		case 'loyalty':
			return { sql: `loyalty IS NOT NULL AND loyalty != ''`, args: [] };
		case 'pt':
			return {
				sql: `power IS NOT NULL AND power != ''
					AND toughness IS NOT NULL AND toughness != ''`,
				args: []
			};
		case 'multifaced':
			return {
				sql: `lower(json_extract(printing_metadata, '$.layout'))
					IN ('split', 'flip', 'transform', 'modal_dfc', 'meld', 'adventure',
						'reversible_card', 'art_series', 'double_faced_token')`,
				args: []
			};
		case 'securitystamp':
			return {
				sql: `json_extract(printing_metadata, '$.securityStamp') IS NOT NULL`,
				args: []
			};
		case 'artist':
			return { sql: `artist IS NOT NULL AND artist != ''`, args: [] };
		case 'mana':
			return { sql: `mana_cost IS NOT NULL AND mana_cost != ''`, args: [] };
		default:
			return { sql: '0=1', args: [] };
	}
}

function buildFilterSql(filter: FilterNode, useSharedOracleTags: boolean): SqlFragment {
	switch (filter.kind) {
		case 'name': {
			const column = 'name';
			if (filter.mode === 'exact') {
				return {
					sql: filter.negate ? `lower(${column}) != lower(?)` : `lower(${column}) = lower(?)`,
					args: [filter.value]
				};
			}
			if (filter.mode === 'regex') {
				return {
					sql: filter.negate ? `NOT regexp(?, ${column})` : `regexp(?, ${column})`,
					args: [filter.value]
				};
			}
			return {
				sql: filter.negate ? `${column} NOT LIKE ? ESCAPE '\\'` : `${column} LIKE ? ESCAPE '\\'`,
				args: [`%${escapeLike(filter.value)}%`]
			};
		}

		case 'type':
			return filter.mode === 'regex'
				? {
						sql: filter.negate ? `NOT regexp(?, type_line)` : `regexp(?, type_line)`,
						args: [filter.value]
					}
				: {
						sql: filter.negate
							? `type_line NOT LIKE ? ESCAPE '\\'`
							: `type_line LIKE ? ESCAPE '\\'`,
						args: [`%${escapeLike(filter.value)}%`]
					};

		case 'oracle':
			return filter.mode === 'regex'
				? {
						sql: filter.negate
							? `(oracle_text IS NULL OR NOT regexp(?, oracle_text))`
							: `regexp(?, oracle_text)`,
						args: [filter.value]
					}
				: {
						sql: filter.negate
							? `(oracle_text IS NULL OR oracle_text NOT LIKE ? ESCAPE '\\')`
							: `oracle_text LIKE ? ESCAPE '\\'`,
						args: [`%${escapeLike(filter.value)}%`]
					};

		case 'mv': {
			const actualOp = filter.negate ? negateComparisonOp(filter.op) : filter.op;
			return { sql: `cmc ${actualOp} ?`, args: [filter.val] };
		}

		case 'set':
			return {
				sql: filter.negate ? `set_code != ?` : `set_code = ?`,
				args: [filter.value]
			};

		case 'cn': {
			const op = filter.op ?? '=';
			const actualOp = filter.negate ? negateComparisonOp(op) : op;
			return {
				sql:
					op === '='
						? `collector_number ${actualOp} ?`
						: `CAST(collector_number AS INTEGER) ${actualOp} CAST(? AS INTEGER)`,
				args: [filter.value]
			};
		}

		case 'rarity': {
			const op = filter.op ?? '=';
			const actualOp = filter.negate ? negateComparisonOp(op) : op;
			if (op === '=') {
				return {
					sql: `rarity ${actualOp} ?`,
					args: [filter.value]
				};
			}
			const rank = `CASE rarity
				WHEN 'common' THEN 1
				WHEN 'uncommon' THEN 2
				WHEN 'rare' THEN 3
				WHEN 'special' THEN 4
				WHEN 'mythic' THEN 5
				WHEN 'bonus' THEN 6
				ELSE NULL END`;
			const target = `CASE ?
				WHEN 'common' THEN 1
				WHEN 'uncommon' THEN 2
				WHEN 'rare' THEN 3
				WHEN 'special' THEN 4
				WHEN 'mythic' THEN 5
				WHEN 'bonus' THEN 6 END`;
			return {
				sql: `${rank} ${actualOp} ${target}`,
				args: [filter.value]
			};
		}

		case 'price': {
			const actualOp = filter.negate ? negateComparisonOp(filter.op) : filter.op;
			return { sql: `price_usd ${actualOp} ?`, args: [filter.val] };
		}

		case 'legality': {
			const matched = `json_extract(legalities, ?) = ?`;
			return {
				sql: filter.negate
					? `(legalities IS NOT NULL AND NOT (${matched}))`
					: `(legalities IS NOT NULL AND ${matched})`,
				args: [`$.${filter.format}`, filter.status]
			};
		}

		case 'stat':
			return {
				sql: filter.negate
					? `NOT stat_compare(?, ?, ${filter.field})`
					: `stat_compare(?, ?, ${filter.field})`,
				args: [filter.op, filter.value]
			};

		case 'keyword': {
			const matched = `EXISTS (
				SELECT 1 FROM json_each(keywords)
				WHERE lower(value) = lower(?)
			)`;
			return {
				sql: filter.negate ? `NOT (${matched})` : matched,
				args: [filter.value]
			};
		}

		case 'produces': {
			const matches = filter.chars.map(
				() => `EXISTS (
					SELECT 1 FROM json_each(produced_mana)
					WHERE upper(value) = ?
				)`
			);
			const matched = matches.length > 0 ? matches.join(' AND ') : '0=1';
			return {
				sql: filter.negate ? `NOT (${matched})` : `(${matched})`,
				args: filter.chars
			};
		}

		case 'textMetadata': {
			const column = filter.field;
			if (filter.mode === 'regex') {
				return {
					sql: filter.negate
						? `(${column} IS NULL OR NOT regexp(?, ${column}))`
						: `regexp(?, ${column})`,
					args: [filter.value]
				};
			}
			return {
				sql: filter.negate
					? `(${column} IS NULL OR ${column} NOT LIKE ? ESCAPE '\\')`
					: `${column} LIKE ? ESCAPE '\\'`,
				args: [`%${escapeLike(filter.value)}%`]
			};
		}

		case 'date': {
			const actualOp = filter.negate ? negateComparisonOp(filter.op) : filter.op;
			if (filter.field === 'year') {
				return {
					sql: `CAST(substr(released_at, 1, 4) AS INTEGER) ${actualOp} ?`,
					args: [Number(filter.value)]
				};
			}
			if (filter.op === '=') {
				return {
					sql: filter.negate
						? `(released_at IS NULL OR substr(released_at, 1, ?) != ?)`
						: `substr(released_at, 1, ?) = ?`,
					args: [filter.value.length, filter.value]
				};
			}
			const start =
				filter.value.length === 4
					? `${filter.value}-01-01`
					: filter.value.length === 7
						? `${filter.value}-01`
						: filter.value;
			const end =
				filter.value.length === 4
					? `${filter.value}-12-31`
					: filter.value.length === 7
						? `${filter.value}-31`
						: filter.value;
			const boundary = filter.op === '<=' || filter.op === '>' ? end : start;
			return {
				sql: filter.negate
					? `(released_at IS NULL OR released_at ${actualOp} ?)`
					: `released_at ${actualOp} ?`,
				args: [boundary]
			};
		}

		case 'printingMetadata': {
			const arrayPath =
				filter.field === 'game' ? '$.games' : filter.field === 'finish' ? '$.finishes' : null;
			const matched = arrayPath
				? `EXISTS (
						SELECT 1 FROM json_each(printing_metadata, '${arrayPath}')
						WHERE lower(value) = lower(?)
					)`
				: `lower(json_extract(printing_metadata, '$.${filter.field}')) = lower(?)`;
			return {
				sql: filter.negate ? `NOT COALESCE((${matched}), 0)` : `COALESCE((${matched}), 0)`,
				args: [filter.value]
			};
		}

		case 'in': {
			const language = LANGUAGE_NAME_MAP[filter.value] ?? filter.value;
			const matched = `(
				lower(set_code) = lower(?)
				OR lower(json_extract(printing_metadata, '$.setName')) LIKE lower(?) ESCAPE '\\'
				OR lower(json_extract(printing_metadata, '$.setType')) = lower(?)
				OR lower(json_extract(printing_metadata, '$.lang')) = lower(?)
				OR EXISTS (
					SELECT 1 FROM json_each(printing_metadata, '$.games')
					WHERE lower(value) = lower(?)
				)
			)`;
			return {
				sql: filter.negate ? `NOT COALESCE(${matched}, 0)` : `COALESCE(${matched}, 0)`,
				args: [filter.value, `%${escapeLike(filter.value)}%`, filter.value, language, filter.value]
			};
		}

		case 'is': {
			const predicate = buildIsPredicate(filter.value);
			return {
				sql: filter.negate
					? `NOT COALESCE((${predicate.sql}), 0)`
					: `COALESCE((${predicate.sql}), 0)`,
				args: predicate.args
			};
		}

		case 'has': {
			const predicate = buildHasPredicate(filter.value);
			return {
				sql: filter.negate
					? `NOT COALESCE((${predicate.sql}), 0)`
					: `COALESCE((${predicate.sql}), 0)`,
				args: predicate.args
			};
		}

		case 'oracleTag': {
			const matched = useSharedOracleTags
				? `shared_oracle_tag(?, oracle_id) = 1`
				: `EXISTS (
						SELECT 1
						FROM scryfall_oracle_tag_cards tc
						JOIN scryfall_oracle_tags t ON t.id = tc.tag_id
						WHERE tc.oracle_id = scryfall_cache.oracle_id
						  AND t.label = ? COLLATE NOCASE
					)`;
			return {
				sql: filter.negate
					? `(oracle_id IS NOT NULL AND NOT (${matched}))`
					: `(oracle_id IS NOT NULL AND ${matched})`,
				args: [filter.value.toLowerCase()]
			};
		}

		case 'color':
			return buildColorSql('colors', filter.chars, filter.colorless, filter.op, filter.negate);

		case 'identity':
			return buildColorSql(
				'color_identity',
				filter.chars,
				filter.colorless,
				filter.op,
				filter.negate
			);
	}
}

function buildExpressionSql(
	expression: SearchExpression,
	useSharedOracleTags: boolean
): SqlFragment {
	if (expression.kind === 'term') {
		return buildFilterSql(expression.filter, useSharedOracleTags);
	}
	if (expression.kind === 'not') {
		const child = buildExpressionSql(expression.child, useSharedOracleTags);
		return { sql: `NOT (${child.sql})`, args: child.args };
	}

	const children = expression.children.map((child) =>
		buildExpressionSql(child, useSharedOracleTags)
	);
	return {
		sql: `(${children.map((child) => `(${child.sql})`).join(` ${expression.kind.toUpperCase()} `)})`,
		args: children.flatMap((child) => child.args)
	};
}

// ── Cache readiness ───────────────────────────────────────────────────────────

function checkCacheReadiness(
	d: Database.Database,
	ast: SearchAST,
	sharedOracleTags?: SharedOracleTagIndex
): void {
	const needsColors = ast.filters.some((f) => f.kind === 'color' || f.kind === 'identity');
	const needsRarity = ast.filters.some((f) => f.kind === 'rarity');
	const needsLegalities = ast.filters.some((f) => f.kind === 'legality');
	const needsOracleTags = ast.filters.some((f) => f.kind === 'oracleTag');
	const needsEdhrec = ast.sort === 'edhrec';
	const requiredNewColumns = new Map<string, string>();
	for (const filter of ast.filters) {
		if (filter.kind === 'stat') requiredNewColumns.set(filter.field, filter.field);
		if (filter.kind === 'keyword') requiredNewColumns.set('keywords', 'keyword');
		if (filter.kind === 'produces') requiredNewColumns.set('produced_mana', 'produces');
		if (filter.kind === 'textMetadata') {
			requiredNewColumns.set(filter.field, filter.field.replace('_', ' '));
		}
		if (filter.kind === 'date') requiredNewColumns.set('released_at', 'release date');
		if (filter.kind === 'printingMetadata' || filter.kind === 'in') {
			requiredNewColumns.set('printing_metadata', 'printing metadata');
		}
		if (filter.kind === 'is') {
			if (['companion', 'leveler', 'frenchvanilla'].includes(filter.value)) {
				requiredNewColumns.set('keywords', 'keyword');
			}
			if (
				![
					'commander',
					'brawler',
					'oathbreaker',
					'duelcommander',
					'companion',
					'hybrid',
					'phyrexian',
					'leveler',
					'spell',
					'permanent',
					'historic',
					'party',
					'modal',
					'vanilla',
					'frenchvanilla',
					'unique'
				].includes(filter.value)
			) {
				requiredNewColumns.set('printing_metadata', 'printing metadata');
			}
		}
		if (filter.kind === 'has') {
			if (filter.value === 'loyalty') requiredNewColumns.set('loyalty', 'loyalty');
			if (filter.value === 'pt') {
				requiredNewColumns.set('power', 'power');
				requiredNewColumns.set('toughness', 'toughness');
			}
			if (
				['indicator', 'foil', 'nonfoil', 'promo', 'multifaced', 'securitystamp'].includes(
					filter.value
				)
			) {
				requiredNewColumns.set('printing_metadata', 'printing metadata');
			}
		}
	}

	if (needsColors) {
		const row = d.prepare('SELECT 1 FROM scryfall_cache WHERE colors IS NOT NULL LIMIT 1').get();
		if (!row) throw new CacheNotReadyError('color/identity');
	}
	if (needsRarity) {
		const row = d.prepare('SELECT 1 FROM scryfall_cache WHERE rarity IS NOT NULL LIMIT 1').get();
		if (!row) throw new CacheNotReadyError('rarity');
	}
	if (needsLegalities) {
		const row = d
			.prepare('SELECT 1 FROM scryfall_cache WHERE legalities IS NOT NULL LIMIT 1')
			.get();
		if (!row) throw new CacheNotReadyError('format legality');
	}
	if (needsOracleTags && !sharedOracleTags) {
		const table = d
			.prepare(
				`SELECT 1 FROM sqlite_master
			 WHERE type = 'table' AND name = 'scryfall_oracle_tags'`
			)
			.get();
		const populated = table
			? d.prepare('SELECT 1 FROM scryfall_oracle_tags LIMIT 1').get()
			: undefined;
		if (!populated) {
			throw new CacheNotReadyError('Oracle tag', 'pnpm scryfall:tags');
		}
	}
	if (needsEdhrec) {
		const row = d
			.prepare('SELECT 1 FROM scryfall_cache WHERE edhrec_rank IS NOT NULL LIMIT 1')
			.get();
		if (!row) throw new CacheNotReadyError('edhrec sort');
	}
	for (const [column, label] of requiredNewColumns) {
		const row = d.prepare(`SELECT 1 FROM scryfall_cache WHERE ${column} IS NOT NULL LIMIT 1`).get();
		if (!row) throw new CacheNotReadyError(label);
	}
}

// ── Executor ──────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 900;

type SortRow = {
	id: string;
	name: string;
	cmc: number;
	price_usd: number | null;
	price_usd_foil: number | null;
	edhrec_rank: number | null;
	set_code: string;
	collector_number: string;
};

function runChunk(
	d: Database.Database,
	conditions: string[],
	args: (string | number)[],
	chunkIds: string[]
): SortRow[] {
	const placeholders = chunkIds.map(() => '?').join(', ');
	const idCond = `id IN (${placeholders})`;
	const where =
		conditions.length > 0 ? `WHERE ${conditions.join(' AND ')} AND ${idCond}` : `WHERE ${idCond}`;

	const stmt = d.prepare(
		`SELECT id, name, cmc, price_usd, price_usd_foil, edhrec_rank, set_code, collector_number
		 FROM scryfall_cache ${where}`
	);
	return stmt.all(...args, ...chunkIds) as SortRow[];
}

/**
 * Execute a parsed AST against the Scryfall SQLite cache, restricted to candidateIds.
 *
 * Returns IDs sorted per ast.sort + ast.direction, nulls always last.
 * Returns null when there are no filters (caller must sort without restricting IDs).
 * Throws CacheNotReadyError when required cache columns are absent.
 *
 * Resource safety: a fresh connection opened via dbPath is closed before returning.
 * The singleton production connection is never closed.
 */
export function executeSearch(
	ast: SearchAST,
	candidateIds: string[],
	dbPath?: string,
	sharedOracleTags?: SharedOracleTagIndex
): string[] | null {
	const hasFilters = ast.requiresExecutor && ast.expression !== null;

	// Sort-only (no filter nodes) → return null so routes do not add scryfallId IN (...).
	// Collection rows with no scryfallId must remain visible; applySortToEntries handles sorting.
	// Still check edhrec cache readiness before returning null so the user sees the error promptly.
	if (!hasFilters) {
		if (ast.sort === 'edhrec') {
			const d = openDb(dbPath);
			try {
				checkCacheReadiness(d, ast, sharedOracleTags);
			} finally {
				if (dbPath) d.close();
			}
		}
		return null;
	}

	if (candidateIds.length === 0) return [];

	const d = openDb(dbPath);
	try {
		checkCacheReadiness(d, ast, sharedOracleTags);
		d.function('regexp', { deterministic: true }, (pattern: string, value: string | null) =>
			value !== null && new RegExp(pattern, 'i').test(value) ? 1 : 0
		);
		d.function(
			'stat_compare',
			{ deterministic: true },
			(op: string, target: string, stored: string | null) => {
				if (stored === null) return 0;
				const values = stored.split(' // ').map((value) => value.trim());
				if (op === '=') {
					return values.some((value) => value.toLowerCase() === target.toLowerCase()) ? 1 : 0;
				}
				const targetNumber = Number(target);
				if (!Number.isFinite(targetNumber)) return 0;
				return values.some((value) => {
					const actual = Number(value);
					if (!Number.isFinite(actual)) return false;
					switch (op) {
						case '>=':
							return actual >= targetNumber;
						case '<=':
							return actual <= targetNumber;
						case '>':
							return actual > targetNumber;
						case '<':
							return actual < targetNumber;
						default:
							return false;
					}
				})
					? 1
					: 0;
			}
		);
		d.function(
			'is_french_vanilla',
			{ deterministic: true },
			(oracleText: string | null, keywordJson: string | null) => {
				if (!oracleText || !keywordJson) return 0;
				let keywords: string[];
				try {
					keywords = JSON.parse(keywordJson) as string[];
				} catch {
					return 0;
				}
				if (keywords.length === 0) return 0;
				const normalizedKeywords = keywords.map((keyword) => keyword.toLowerCase());
				const clauses = oracleText
					.split(/\n|,\s+/)
					.map((clause) => clause.trim().toLowerCase())
					.filter(Boolean);
				return clauses.length > 0 &&
					clauses.every((clause) =>
						normalizedKeywords.some((keyword) => clause.startsWith(keyword))
					)
					? 1
					: 0;
			}
		);
		if (sharedOracleTags) {
			d.function(
				'shared_oracle_tag',
				{ deterministic: true },
				(label: string, oracleId: string | null) =>
					oracleId !== null && (sharedOracleTags.get(label.toLowerCase())?.has(oracleId) ?? false)
						? 1
						: 0
			);
		}

		const expression = buildExpressionSql(ast.expression!, !!sharedOracleTags);
		const conditions = [expression.sql];
		const args = expression.args;

		const allRows: SortRow[] = [];
		for (let i = 0; i < candidateIds.length; i += CHUNK_SIZE) {
			allRows.push(...runChunk(d, conditions, args, candidateIds.slice(i, i + CHUNK_SIZE)));
		}

		// Sort merged results — nulls always last regardless of direction
		const dir = ast.direction === 'desc' ? -1 : 1;
		allRows.sort((a, b) => {
			switch (ast.sort) {
				case 'mv':
					return dir * (a.cmc - b.cmc);
				case 'price': {
					const ap = a.price_usd,
						bp = b.price_usd;
					if (ap === null && bp === null) return 0;
					if (ap === null) return 1;
					if (bp === null) return -1;
					return dir * (ap - bp);
				}
				case 'edhrec': {
					const ae = a.edhrec_rank,
						be = b.edhrec_rank;
					if (ae === null && be === null) return 0;
					if (ae === null) return 1;
					if (be === null) return -1;
					return dir * (ae - be);
				}
				case 'set': {
					const sc = dir * a.set_code.localeCompare(b.set_code);
					return sc !== 0
						? sc
						: dir *
								a.collector_number.localeCompare(b.collector_number, undefined, { numeric: true });
				}
				default:
					return dir * a.name.localeCompare(b.name);
			}
		});

		return allRows.map((r) => r.id);
	} finally {
		if (dbPath) d.close();
	}
}
