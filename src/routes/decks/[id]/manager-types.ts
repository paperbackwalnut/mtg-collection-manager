// Shared types for the Manager view components.
// These mirror shapes produced by +page.server.ts — kept separate to avoid
// importing from the route module itself.

export type CopyConflict = {
	assignmentId: number;
	deckName: string;
	status: string;
};

export type CopyOption = {
	id: number;
	setCode: string;
	collectorNumber: string;
	foil: boolean;
	condition: string;
	quantity: number;
	available: number;
	locationOverride: string | null;
	conflicts: CopyConflict[];
};

export type ManagerAssignment = {
	id: number;
	status: string; // fulfillment: unassigned|needed|ordered|assigned|proxied
	pulled: boolean; // physical state: is card currently in the deck box?
	collectionId: number | null;
	proxyInventoryId: number | null;
	collSetCode: string | null;
	collCollectorNumber: string | null;
	collFoil: boolean | null;
	collCondition: string | null;
	collLocationOverride: string | null;
	proxySetCode: string | null;
	proxyCollectorNumber: string | null;
	note: string | null;
	printStatus: string | null;
	imageUri: string | null;
	location: string | null;
	typeLine: string | null;
	manaCost: string | null;
	cmc: number | null;
};

export type ManagerCard = {
	dcId: number;
	cardName: string;
	quantity: number;
	board: string | null;
	notes: string | null;
	fallbackImageUri: string | null;
	typeLine: string | null;
	manaCost: string | null;
	assignments: ManagerAssignment[];
	/** Total copies owned across the whole collection (0 = Not Owned). */
	collQty: number;
	/** Copies not yet committed to any real-card deck assignment.
	 *  0 with collQty > 0 means All Copies Used. */
	availableQty: number;
	/** Decks currently committing owned copies of this card. */
	conflictDecks: string[];
	/** Owned collection printings for this card, with exact-copy availability context. */
	collectionPrintings: Array<{
		id: number;
		setCode: string;
		collectorNumber: string;
		foil: boolean | null;
		condition: string | null;
		quantity: number;
		available: number;
		locationOverride: string | null;
		assignedDecks: string[];
	}>;
	/** Unreserved printed proxies matching this card, available for explicit reservation. */
	availableProxyInventory: Array<{
		id: number;
		cardName: string;
		setCode: string | null;
		collectorNumber: string | null;
		printState: string;
		location: string;
	}>;
	/** Copies added by Moxfield sync and not yet reviewed. */
	syncAddedQuantity: number;
	/** Packed copies Moxfield removed that still need to leave this deck. */
	syncReturnCount: number;
	/** Exact packed assignment IDs selected by the sync reduction. */
	syncReturnAssignmentIds: number[];
};

export type ManagerPreviewCard = {
	name: string;
	imageUri: string | null;
	printing: string | null;
};

export type ManagerGroupData = {
	label: string;
	key: string | number;
	items: Array<{ card: ManagerCard; board: string }>;
	total: number;
	done: number;
};

export type ManagerSection = {
	label: string;
	groups: ManagerGroupData[];
};

/** Shared state + actions injected via Svelte context by ManagerView. */
export type ManagerCtx = {
	// ── Actions passed in from +page.svelte ──────────────────────────────
	patchAssignment: (
		id: number,
		patch: {
			status?: string;
			pulled?: boolean;
			collectionId?: number | null;
			override?: boolean;
			proxifyConflicts?: boolean;
			printStatus?: string | null;
		}
	) => Promise<void>;
	patchPrintStatus: (id: number, printStatus: string | null) => Promise<void>;
	applyLocalPatch: (
		id: number,
		patch: {
			status?: string;
			pulled?: boolean;
			note?: string | null;
			printStatus?: string | null;
			proxyInventoryId?: number | null;
		}
	) => void;
	openNoteModal: (deckCardId: number, cardName: string, notes: string) => void;
	get canEditDeck(): boolean;
	mutateDeckCard: (
		deckCardId: number,
		patch: {
			quantity?: number;
			board?: 'main' | 'side' | 'maybe' | 'commander';
		}
	) => Promise<boolean>;

	// ── Copy-dropdown state (owned by ManagerView) ───────────────────────
	// Accessed via getter so Svelte 5 tracks the underlying $state reactively.
	get copyDropdownId(): number | null;
	get copyDropdownCache(): Map<number, CopyOption[]>;
	get copyDropdownLoading(): boolean;
	openCopyDropdown: (id: number) => Promise<void>;
	closeCopyDropdown: () => void;

	// ── Inline proxy-note state (owned by ManagerView) ───────────────────
	get inlineNoteId(): number | null;
	get inlineNoteText(): string;
	setInlineNote: (id: number, text: string) => void;
	cancelInlineNote: () => void;
	saveInlineNote: (id: number) => Promise<void>;

	// ── Sticky preview rail ───────────────────────────────────────────────
	setPreviewCard: (card: ManagerPreviewCard) => void;

	// ── App settings ──────────────────────────────────────────────────────
	/** When true, basic lands are excluded from Missing/problem indicators. */
	get ignoreBasics(): boolean;

	// ── Bulk selection ────────────────────────────────────────────────────
	get selectedIds(): Set<number>;
	toggleSelect: (id: number) => void;
	setSelected: (ids: number[], selected: boolean) => void;
	clearSelection: () => void;
};
