import { sqliteTable, text, integer, real, index, unique } from 'drizzle-orm/sqlite-core';

// scryfallCache was removed — Scryfall data now lives in a local SQLite file
// (scryfall.db) on each machine. See src/lib/server/db/scryfall-sqlite.ts.

export const collection = sqliteTable(
	'collection',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		scryfallId: text('scryfall_id'), // Scryfall UUID — no FK (cache is local SQLite)
		oracleId: text('oracle_id'), // Oracle UUID — stable card identity shared across printings
		name: text('name').notNull(),
		setCode: text('set_code').notNull(),
		collectorNumber: text('collector_number').notNull(),
		condition: text('condition').default('NM'),
		language: text('language').default('English'),
		foil: integer('foil', { mode: 'boolean' }).default(false),
		quantity: integer('quantity').notNull().default(1),
		purchasePrice: real('purchase_price'),
		// null = auto-compute; otherwise one of the physical locations in src/lib/types.ts
		locationOverride: text('location_override'),
		tags: text('tags') // JSON array string
	},
	(t) => [index('coll_name_idx').on(t.name), index('coll_oracle_idx').on(t.oracleId)]
);

export const decks = sqliteTable('decks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	format: text('format'),
	commander: text('commander'),
	moxfieldUrl: text('moxfield_url'),
	sourceMode: text('source_mode').notNull().default('local'), // 'local'|'moxfield'
	lastSyncAttemptedAt: integer('last_sync_attempted_at'),
	lastSyncedAt: integer('last_synced_at'),
	lastSyncStatus: text('last_sync_status'), // 'success'|'pending'|'error'
	lastSyncError: text('last_sync_error'),
	notes: text('notes'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	archivedAt: integer('archived_at')
});

export const deckCards = sqliteTable(
	'deck_cards',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		deckId: integer('deck_id')
			.notNull()
			.references(() => decks.id, { onDelete: 'cascade' }),
		cardName: text('card_name').notNull(),
		quantity: integer('quantity').notNull().default(1),
		setCode: text('set_code'),
		collectorNumber: text('collector_number'),
		board: text('board').default('main'), // 'main'|'side'|'maybe'|'commander'
		isCommander: integer('is_commander', { mode: 'boolean' }).default(false),
		notes: text('notes')
	},
	(t) => [index('dc_deck_idx').on(t.deckId)]
);

export const orders = sqliteTable('orders', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cardName: text('card_name').notNull(),
	setCode: text('set_code'),
	collectorNumber: text('collector_number'),
	quantity: integer('quantity').notNull().default(1),
	source: text('source').notNull().default('other'), // 'tcgplayer'|'ebay'|'lgs'|'other'
	notes: text('notes'),
	status: text('status').notNull().default('ordered'), // 'ordered'|'arrived'|'cancelled'
	orderedAt: integer('ordered_at').notNull(),
	arrivedAt: integer('arrived_at')
});

export const shoppingList = sqliteTable(
	'shopping_list',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		cardName: text('card_name').notNull(),
		quantity: integer('quantity').notNull().default(1),
		notes: text('notes'),
		source: text('source'), // 'missing'|'shortfalls'|'manual'
		addedAt: integer('added_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [unique('sl_card_name_unique').on(t.cardName)]
);

// One row per physical printed proxy. Assignment links reserve copies; an
// unlinked row is available in its home location for reuse.
export const proxyInventory = sqliteTable(
	'proxy_inventory',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		cardName: text('card_name').notNull(),
		oracleId: text('oracle_id'),
		scryfallId: text('scryfall_id'),
		setCode: text('set_code'),
		collectorNumber: text('collector_number'),
		location: text('location').notNull().default('proxy_box'),
		printState: text('print_state').notNull().default('ready'), // 'ready'|'needs_reprint'
		notes: text('notes'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		index('pi_card_name_idx').on(t.cardName),
		index('pi_oracle_idx').on(t.oracleId),
		index('pi_scryfall_idx').on(t.scryfallId),
		index('pi_location_idx').on(t.location)
	]
);

// One row per individual copy being tracked for a deck slot.
// deck_cards.quantity=4 means 4 cardAssignment rows will be created for it.
export const cardAssignments = sqliteTable(
	'card_assignments',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		deckCardId: integer('deck_card_id')
			.notNull()
			.references(() => deckCards.id, { onDelete: 'cascade' }),
		deckId: integer('deck_id')
			.notNull()
			.references(() => decks.id, { onDelete: 'cascade' }),
		cardName: text('card_name').notNull(),
		// null when status is 'unassigned', 'needed', or 'proxied'
		collectionId: integer('collection_id').references(() => collection.id),
		// Physical printed proxy reserved by this assignment. Unique when non-null.
		proxyInventoryId: integer('proxy_inventory_id').references(() => proxyInventory.id, {
			onDelete: 'set null'
		}),
		// For proxies: track which printing to use (optional)
		proxySetCode: text('proxy_set_code'),
		proxyCollectorNumber: text('proxy_collector_number'),
		// Fulfillment: 'unassigned' | 'needed' | 'ordered' | 'assigned' | 'proxied'
		// (legacy 'pulled' status was migrated → status='assigned', pulled=true)
		status: text('status').notNull().default('unassigned'),
		// Physical state: is this card currently in the deck box?
		// Valid only when status is 'assigned' or 'proxied'.
		pulled: integer('pulled', { mode: 'boolean' }).notNull().default(false),
		// Free-text note for this assignment slot (e.g. "fullart custom" for proxies)
		note: text('note'),
		// Print flag: only relevant for proxied + pulled=false
		printStatus: text('print_status')
	},
	(t) => [
		index('ca_deck_idx').on(t.deckId),
		index('ca_coll_idx').on(t.collectionId),
		unique('ca_proxy_inventory_unique').on(t.proxyInventoryId)
	]
);

// A Moxfield sync keeps protected local copies in place and records the
// upstream quantity it could not safely reach. One pending row exists per card.
export const deckPendingRemovals = sqliteTable(
	'deck_pending_removals',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		deckId: integer('deck_id')
			.notNull()
			.references(() => decks.id, { onDelete: 'cascade' }),
		deckCardId: integer('deck_card_id')
			.notNull()
			.references(() => deckCards.id, { onDelete: 'cascade' }),
		cardName: text('card_name').notNull(),
		board: text('board').notNull().default('main'),
		targetQuantity: integer('target_quantity').notNull(),
		detectedAt: integer('detected_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [unique('dpr_deck_card_unique').on(t.deckCardId), index('dpr_deck_idx').on(t.deckId)]
);

// Exact packed copies selected by a pending Moxfield removal. The parent
// remains card-level while these rows preserve printing/location identity.
export const deckPendingReturnAssignments = sqliteTable(
	'deck_pending_return_assignments',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		pendingRemovalId: integer('pending_removal_id')
			.notNull()
			.references(() => deckPendingRemovals.id, { onDelete: 'cascade' }),
		assignmentId: integer('assignment_id')
			.notNull()
			.references(() => cardAssignments.id),
		detectedAt: integer('detected_at').notNull()
	},
	(t) => [
		unique('dpra_assignment_unique').on(t.assignmentId),
		index('dpra_pending_idx').on(t.pendingRemovalId)
	]
);

// Additions remain visible in Manager until the user reviews them. One row
// per deck card is enough because the card row carries its assignment detail.
export const deckSyncAdditions = sqliteTable(
	'deck_sync_additions',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		deckId: integer('deck_id')
			.notNull()
			.references(() => decks.id, { onDelete: 'cascade' }),
		deckCardId: integer('deck_card_id')
			.notNull()
			.references(() => deckCards.id, { onDelete: 'cascade' }),
		cardName: text('card_name').notNull(),
		board: text('board').notNull().default('main'),
		quantity: integer('quantity').notNull(),
		detectedAt: integer('detected_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [unique('dsa_deck_card_unique').on(t.deckCardId), index('dsa_deck_idx').on(t.deckId)]
);
