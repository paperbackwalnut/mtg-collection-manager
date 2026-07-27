export type CardLocation =
	| 'binder'
	| 'holding_box'
	| 'box_w'
	| 'box_u'
	| 'box_b'
	| 'box_r'
	| 'box_g'
	| 'box_multi'
	| 'box_colorless'
	| 'box_land'
	| 'proxy_box'
	| 'unknown';

export const LOCATION_LABELS: Record<CardLocation, string> = {
	binder: '$10+ Binder',
	holding_box: 'Holding Box',
	box_w: 'White Box (W)',
	box_u: 'Blue Box (U)',
	box_b: 'Black Box (B)',
	box_r: 'Red Box (R)',
	box_g: 'Green Box (G)',
	box_multi: 'Multicolor Box',
	box_colorless: 'Colorless Box',
	box_land: 'Land Box',
	proxy_box: 'Proxy Deckbox',
	unknown: 'Unknown'
};

export const LOCATION_ORDER: CardLocation[] = [
	'binder',
	'holding_box',
	'box_w',
	'box_u',
	'box_b',
	'box_r',
	'box_g',
	'box_multi',
	'box_colorless',
	'box_land',
	'proxy_box',
	'unknown'
];

export function isCardLocation(value: string): value is CardLocation {
	return Object.prototype.hasOwnProperty.call(LOCATION_LABELS, value);
}

export const isWritableCardLocation = isCardLocation;

export type AssignmentStatus = 'unassigned' | 'needed' | 'ordered' | 'assigned' | 'proxied';

export const STATUS_LABELS: Record<string, string> = {
	unassigned: 'Unassigned',
	needed: 'Needed',
	ordered: 'Ordered',
	assigned: 'Real Card', // fulfillment type — not physical state
	proxied: 'Proxy'
	// pulled is a boolean field on assignments, not a status
	// derive display label from status + pulled at render time
};

export interface ParsedDeckCard {
	cardName: string;
	quantity: number;
	setCode?: string;
	collectorNumber?: string;
	board: 'main' | 'side' | 'maybe' | 'commander';
	isCommander: boolean;
}

export interface PickListItem {
	assignmentId: number;
	cardName: string;
	setCode: string | null;
	collectorNumber: string | null;
	foil: boolean;
	status: AssignmentStatus;
	location: CardLocation;
	typeOrder: number;
	cmc: number;
	typeLine: string;
	colors: string; // e.g. "WUB" — cached color identity, or mana-cost colors as a fallback
	imageUri: string | null;
	priceUsd: number | null;
	deckId: number;
	deckName: string;
	board: string;
	isCommander: boolean;
	hasCollection: boolean; // true if a real collection copy is assigned
	collectionId: number | null;
	pulled: boolean;
	printStatus: string | null;
}
