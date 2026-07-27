<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { LOCATION_LABELS } from '$lib/types';
	import type { CardLocation } from '$lib/types';
	import CardImage from '$lib/components/CardImage.svelte';
	import ManagerView from './ManagerView.svelte';
	import { onMount } from 'svelte';
	import { getIgnoreMaybeboard } from '$lib/app-settings';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let ignoreMaybeboard = $state(false);
	onMount(() => {
		ignoreMaybeboard = getIgnoreMaybeboard();
	});

	let editing = $state(false);
	let confirmDelete = $state(false);
	let confirmArchive = $state(false);
	let confirmConvert = $state(false);
	let syncing = $state(false);
	let syncClientError = $state<string | null>(null);
	const syncProgressSteps = [
		'Fetching latest Moxfield list',
		'Comparing local deck state',
		'Preserving packed and assigned copies',
		'Refreshing deck view'
	];
	let autoAssigning = $state(false);
	let pendingBusyId = $state<number | null>(null);
	let deckMutationError = $state('');
	let deckMutationMessage = $state('');
	let viewMode = $state<'manager' | 'table' | 'decklist' | 'visual' | 'board'>('manager');

	function focusOnMount(node: HTMLElement) {
		node.focus();
	}

	// ── Per-board sort state ──────────────────────────────────────────────────
	type SortCol = 'name' | 'cmc' | 'status' | 'location' | 'copy';
	type BoardSort = { col: SortCol; dir: 'asc' | 'desc' };
	let boardSort = $state<Record<string, BoardSort>>({});

	function getSort(board: string): BoardSort {
		return boardSort[board] ?? { col: 'name', dir: 'asc' };
	}
	function toggleSort(board: string, col: SortCol) {
		const cur = getSort(board);
		boardSort = {
			...boardSort,
			[board]:
				cur.col === col ? { col, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }
		};
	}
	function sortIcon(board: string, col: SortCol) {
		const cur = getSort(board);
		if (cur.col !== col) return '⇅';
		return cur.dir === 'asc' ? '▲' : '▼';
	}

	// ── Filter state ──────────────────────────────────────────────────────────
	let filterSearch = $state('');
	// Set of statuses to HIDE from the table (empty = show all)
	let hiddenStatuses = $state(new Set<string>());

	function toggleHideStatus(status: string) {
		const s = new Set(hiddenStatuses);
		if (s.has(status)) s.delete(status);
		else s.add(status);
		hiddenStatuses = s;
	}

	// ── Basic lands collapse ──────────────────────────────────────────────────
	const BASIC_LAND_NAMES = new Set([
		'Plains',
		'Island',
		'Swamp',
		'Mountain',
		'Forest',
		'Wastes',
		'Snow-Covered Plains',
		'Snow-Covered Island',
		'Snow-Covered Swamp',
		'Snow-Covered Mountain',
		'Snow-Covered Forest'
	]);

	function isBasicLand(card: {
		cardName: string;
		assignments: Array<{ typeLine?: string | null }>;
	}): boolean {
		if (BASIC_LAND_NAMES.has(card.cardName)) return true;
		const tl = (card.assignments[0]?.typeLine ?? '').toLowerCase();
		return tl.includes('basic') && tl.includes('land');
	}

	let basicsCollapsed = $state<Record<string, boolean>>({});

	// ── Inline copy dropdown ──────────────────────────────────────────────────
	type CopyConflict = { assignmentId: number; deckName: string; status: string };
	type CopyOption = {
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

	let copyDropdownId = $state<number | null>(null);
	let copyDropdownCache = $state<Map<number, CopyOption[]>>(new Map());
	let copyDropdownLoading = $state(false);

	async function openCopyDropdown(assignmentId: number) {
		if (copyDropdownId === assignmentId) {
			copyDropdownId = null;
			return;
		}
		copyDropdownId = assignmentId;
		if (copyDropdownCache.has(assignmentId)) return;
		copyDropdownLoading = true;
		try {
			const res = await fetch(`/api/assignments/${assignmentId}`);
			const copies: CopyOption[] = await res.json();
			const m = new Map(copyDropdownCache);
			m.set(assignmentId, copies);
			copyDropdownCache = m;
		} catch {
			// ignore
		}
		copyDropdownLoading = false;
	}

	// ── Optimistic patches ──────────────────────────────────────────────────────
	// Applied instantly on click; cleared when server data refreshes.
	// Avoids invalidateAll() for simple status/note changes.
	type Patch = {
		status?: string;
		pulled?: boolean;
		note?: string | null;
		printStatus?: string | null;
		proxyInventoryId?: number | null;
	};
	type DeckCardPatch = {
		quantity?: number;
	};
	let localPatches = $state(new Map<number, Patch>());
	let deckCardPatches = $state(new Map<number, DeckCardPatch>());

	function applyPatch(id: number, patch: Patch) {
		const m = new Map(localPatches);
		m.set(id, { ...m.get(id), ...patch });
		localPatches = m;
	}

	function clearPatch(id: number) {
		const m = new Map(localPatches);
		m.delete(id);
		localPatches = m;
	}

	function applyDeckCardPatch(id: number, patch: DeckCardPatch) {
		const m = new Map(deckCardPatches);
		m.set(id, { ...m.get(id), ...patch });
		deckCardPatches = m;
	}

	// data.boards + localPatches merged — feeds statMap and displayBoards
	const patchedBoards = $derived.by(() => {
		if (localPatches.size === 0 && deckCardPatches.size === 0) return data.boards;
		const result: typeof data.boards = {};
		for (const [board, cards] of Object.entries(data.boards)) {
			result[board] = (cards ?? [])
				.map((card) => {
					const cardPatch = deckCardPatches.get(card.dcId);
					return {
						...card,
						...(cardPatch?.quantity !== undefined ? { quantity: cardPatch.quantity } : {}),
						assignments: card.assignments.map((a) => {
							const p = localPatches.get(a.id);
							return p ? { ...a, ...p } : a;
						})
					};
				})
				.filter((card) => card.quantity > 0);
		}
		return result;
	});

	// ── Sort / derived boards ─────────────────────────────────────────────────
	const STATUS_SORT_ORDER = ['unassigned', 'needed', 'ordered', 'proxied', 'assigned'];

	const displayBoards = $derived.by(() => {
		const result: Record<string, (typeof data.boards)[string]> = {};
		for (const [board, cards] of Object.entries(patchedBoards)) {
			const { col, dir } = getSort(board);
			let filtered = (cards ?? []).filter((c) => {
				if (filterSearch && !c.cardName.toLowerCase().includes(filterSearch.toLowerCase()))
					return false;
				// Hide card if ALL its assignments are in hiddenStatuses
				if (hiddenStatuses.size > 0 && c.assignments.every((a) => hiddenStatuses.has(a.status)))
					return false;
				return true;
			});
			filtered = [...filtered].sort((a, b) => {
				const d = dir === 'asc' ? 1 : -1;
				const aA = a.assignments[0];
				const bA = b.assignments[0];
				switch (col) {
					case 'name':
						return a.cardName.localeCompare(b.cardName) * d;
					case 'cmc':
						return ((aA?.cmc ?? 0) - (bA?.cmc ?? 0)) * d;
					case 'status':
						return (
							(STATUS_SORT_ORDER.indexOf(aA?.status ?? '') -
								STATUS_SORT_ORDER.indexOf(bA?.status ?? '')) *
							d
						);
					case 'location':
						return (
							((aA?.location ?? '') as string).localeCompare((bA?.location ?? '') as string) * d
						);
					case 'copy':
						return (
							((aA?.collSetCode ?? '') as string).localeCompare((bA?.collSetCode ?? '') as string) *
							d
						);
					default:
						return 0;
				}
			});
			result[board] = filtered;
		}
		return result;
	});

	// ── Bulk select state ─────────────────────────────────────────────────────
	let bulkMode = $state(false);
	let bulkSelected = $state<Set<number>>(new Set());
	let bulkLoading = $state(false);

	function toggleBulk(id: number) {
		const s = new Set(bulkSelected);
		if (s.has(id)) s.delete(id);
		else s.add(id);
		bulkSelected = s;
	}

	function isBoardAllSelected(board: string) {
		return (displayBoards[board] ?? []).every((c) =>
			c.assignments.every((a) => bulkSelected.has(a.id))
		);
	}

	function toggleBoardSelect(board: string) {
		const s = new Set(bulkSelected);
		const allSelected = isBoardAllSelected(board);
		for (const card of displayBoards[board] ?? [])
			for (const a of card.assignments) allSelected ? s.delete(a.id) : s.add(a.id);
		bulkSelected = s;
	}

	async function runBulkAction(action: string) {
		if (bulkSelected.size === 0) return;
		bulkLoading = true;
		await fetch('/api/assignments/bulk', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: [...bulkSelected], action })
		});
		bulkLoading = false;
		bulkMode = false;
		bulkSelected = new Set();
		await invalidateAll();
		localPatches = new Map(); // server data is now authoritative
	}

	// ── Bulk set-link ──────────────────────────────────────────────────────────
	let bulkSetInput = $state(false); // whether the set-code input row is visible
	let bulkSetCode = $state('');
	let bulkSetResult = $state<{ linked: number; notFound: number; unavailable: number } | null>(
		null
	);
	let bulkSetLoading = $state(false);

	async function runBulkLinkFromSet() {
		if (!bulkSetCode.trim() || bulkSelected.size === 0) return;
		bulkSetLoading = true;
		bulkSetResult = null;
		const res = await fetch('/api/assignments/bulk', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ids: [...bulkSelected],
				action: 'linkFromSet',
				setCode: bulkSetCode.trim()
			})
		});
		const data = await res.json();
		bulkSetResult = data;
		bulkSetLoading = false;
		if (data.linked > 0) {
			await invalidateAll();
			localPatches = new Map();
		}
		// Keep bulk mode open so they can see the result / retry
	}

	const BOARD_ORDER = ['commander', 'main', 'side', 'maybe'];
	const BOARD_LABELS: Record<string, string> = {
		commander: 'Commander',
		main: 'Mainboard',
		side: 'Sideboard',
		maybe: 'Maybeboard'
	};

	const STATUS_CLASSES: Record<string, string> = {
		needed: 'badge-needed',
		ordered: 'badge-ordered',
		assigned: 'badge-assigned',
		proxied: 'badge-proxied'
	};

	const STATUS_LABELS: Record<string, string> = {
		unassigned: 'Unassigned',
		needed: 'Needed',
		ordered: 'Ordered',
		assigned: 'Real Card',
		proxied: 'Proxy'
	};

	// Main/commander only — used for stats bar, Pull All, Unpull All
	const MAIN_BOARDS = new Set(['main', 'commander']);

	function canPullAssignment(a: { status: string; collectionId?: number | null }) {
		return a.status === 'proxied' || (a.status === 'assigned' && a.collectionId !== null);
	}

	function effectiveProxyPrintStatus(a: {
		status: string;
		pulled?: boolean;
		printStatus?: string | null;
		proxyInventoryId?: number | null;
	}) {
		if (a.status !== 'proxied' || a.pulled) return null;
		if (a.printStatus === 'need_reprint') return 'need_reprint';
		if (a.printStatus === 'need_print' && a.proxyInventoryId == null) return 'need_print';
		return null;
	}

	function displayStatus(status: string): string {
		return status;
	}

	function displayLocation(location: string): string {
		return LOCATION_LABELS[location as CardLocation] ?? location;
	}

	function displayedStatusCount(status: string): number {
		return allStatMap[status] ?? 0;
	}

	// Comprehensive stats for the deck — physical state + fulfillment
	let deckStats = $derived.by(() => {
		let inDeck = 0,
			realCards = 0,
			proxy = 0;
		let notPulled = 0,
			needed = 0,
			unassigned = 0,
			ordered = 0,
			needsPrint = 0;
		let maybeCount = 0;
		for (const [board, cards] of Object.entries(patchedBoards)) {
			const isMain = MAIN_BOARDS.has(board);
			const isMaybe = board === 'maybe';
			for (const card of cards) {
				for (const a of card.assignments) {
					if (isMaybe) {
						if (ignoreMaybeboard) {
							maybeCount++;
							continue;
						}
					}
					if (!isMain) continue;
					if (a.pulled) inDeck++;
					switch (a.status) {
						case 'assigned':
							realCards++;
							if (!a.pulled && canPullAssignment(a)) notPulled++;
							break;
						case 'proxied':
							proxy++;
							if (!a.pulled) notPulled++;
							if (effectiveProxyPrintStatus(a)) needsPrint++;
							break;
						case 'needed':
							needed++;
							break;
						case 'unassigned':
							unassigned++;
							break;
						case 'ordered':
							ordered++;
							break;
					}
				}
			}
		}
		const total = realCards + proxy + needed + unassigned + ordered;
		return {
			inDeck,
			realCards,
			proxy,
			notPulled,
			needed,
			unassigned,
			ordered,
			needsPrint,
			total,
			maybeCount
		};
	});
	// sideStatMap removed — side/maybe handling now in deckStats

	// All boards combined — used only for the Hide-status chips so they reflect every card
	let allStatMap = $derived.by(() => {
		const s: Record<string, number> = {};
		for (const [board, cards] of Object.entries(patchedBoards)) {
			if (!MAIN_BOARDS.has(board)) continue;
			if (ignoreMaybeboard && board === 'maybe') continue;
			for (const card of cards) {
				for (const a of card.assignments) {
					s[a.status] = (s[a.status] ?? 0) + 1;
				}
			}
		}
		return s;
	});

	async function patchAssignment(
		assignmentId: number,
		patch: {
			status?: string;
			pulled?: boolean;
			collectionId?: number | null;
			override?: boolean;
			proxifyConflicts?: boolean;
			printStatus?: string | null;
		}
	) {
		// Optimistic update
		const { status, pulled, collectionId, printStatus } = patch;
		applyPatch(assignmentId, {
			...(status !== undefined ? { status } : {}),
			...(pulled !== undefined ? { pulled } : {}),
			...(printStatus !== undefined ? { printStatus } : {})
		});

		const res = await fetch(`/api/assignments/${assignmentId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		});

		if (!res.ok) {
			clearPatch(assignmentId);
			return;
		}

		if (collectionId !== undefined) {
			// Copy assignment changed — need fresh set code / image / location from server
			await invalidateAll();
			localPatches = new Map();
		}
	}

	async function markBasicsAs(board: string, status: 'proxied') {
		const boardCards = patchedBoards[board] ?? [];
		const ids: number[] = [];
		for (const card of boardCards) {
			if (isBasicLand(card)) {
				for (const a of card.assignments) ids.push(a.id);
			}
		}
		if (ids.length === 0) return;

		// Optimistic update for all basic land assignments
		for (const id of ids) applyPatch(id, { status });

		await fetch('/api/assignments/bulk', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids, action: status })
		});
		// No invalidateAll — patches cover the status change
	}

	// ── Print status (proxied cards) ─────────────────────────────────────────────
	async function patchPrintStatus(assignmentId: number, printStatus: string | null) {
		applyPatch(assignmentId, { printStatus });
		await fetch(`/api/assignments/${assignmentId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ printStatus })
		});
		// No invalidateAll — patch already updated local state
	}

	// ── Decklist / Visual view helpers ────────────────────────────────────────

	const TYPE_SECTION_ORDER = [
		{ key: 'commander' as const, label: 'Commander' },
		{ key: 0, label: 'Creatures & Planeswalkers' },
		{ key: 1, label: 'Instants' },
		{ key: 2, label: 'Sorceries' },
		{ key: 3, label: 'Enchantments' },
		{ key: 4, label: 'Auras' },
		{ key: 5, label: 'Rooms & Battles' },
		{ key: 6, label: 'Artifacts' },
		{ key: 7, label: 'Equipment' },
		{ key: 8, label: 'Vehicles' },
		{ key: 9, label: 'Lands' },
		{ key: 10, label: 'Other' }
	];

	function getTypeKey(typeLine: string | null, isCommander: boolean): number | 'commander' {
		if (isCommander) return 'commander';
		const t = (typeLine ?? '').toLowerCase();
		if (t.includes('equipment')) return 7;
		if (t.includes('vehicle')) return 8;
		if (t.includes('creature') || t.includes('planeswalker')) return 0;
		if (t.includes('instant')) return 1;
		if (t.includes('sorcery')) return 2;
		if (t.includes('aura')) return 4;
		if (t.includes('battle') || t.includes('room')) return 5;
		if (t.includes('enchantment')) return 3;
		if (t.includes('artifact')) return 6;
		if (t.includes('land')) return 9;
		return 10;
	}

	const decklistGroups = $derived.by(() => {
		const map = new Map<number | 'commander', typeof data.deckCardsEnriched>();
		for (const card of data.deckCardsEnriched) {
			const key = getTypeKey(card.typeLine ?? null, card.isCommander ?? false);
			if (!map.has(key)) map.set(key, []);
			map.get(key)!.push(card);
		}
		return TYPE_SECTION_ORDER.filter((s) => map.has(s.key)).map((s) => ({
			...s,
			cards: map.get(s.key)!
		}));
	});

	// ── Compact board view ───────────────────────────────────────────────────
	const STATUS_DOT_COLORS: Record<string, string> = {
		needed: 'var(--warning)',
		ordered: 'var(--warning)',
		assigned: 'var(--assigned)',
		proxied: 'var(--proxy)'
	};

	const boardViewGroups = $derived.by(() => {
		// assignments[0]?.typeLine is only populated when a collection copy is linked;
		// use deckCardsEnriched (reliable SQLite data with name fallback) instead.
		const enrichedByDcId = new Map(data.deckCardsEnriched.map((c) => [c.id, c]));

		type Item = {
			card: (typeof data.boards)[string][0] & {
				typeLine: string | null;
				manaCost: string | null;
			};
			board: string;
		};

		function buildGroups(boards: string[]) {
			const typeMap = new Map<number | 'commander', Item[]>();
			for (const board of boards) {
				for (const card of displayBoards[board] ?? []) {
					const enriched = enrichedByDcId.get(card.dcId);
					const typeLine = enriched?.typeLine ?? card.assignments[0]?.typeLine ?? null;
					const manaCost = enriched?.manaCost ?? card.assignments[0]?.manaCost ?? null;
					const key = getTypeKey(typeLine, board === 'commander');
					if (!typeMap.has(key)) typeMap.set(key, []);
					typeMap.get(key)!.push({
						card: { ...card, typeLine, manaCost },
						board
					});
				}
			}
			return TYPE_SECTION_ORDER.filter((s) => typeMap.has(s.key)).map((s) => {
				const items = typeMap.get(s.key)!.sort((a, b) => {
					const aCmc = enrichedByDcId.get(a.card.dcId)?.cmc ?? a.card.assignments[0]?.cmc ?? 0;
					const bCmc = enrichedByDcId.get(b.card.dcId)?.cmc ?? b.card.assignments[0]?.cmc ?? 0;
					return aCmc - bCmc || a.card.cardName.localeCompare(b.card.cardName);
				});
				return {
					label: s.label,
					key: s.key,
					items,
					total: items.reduce((n, { card: c }) => n + c.quantity, 0),
					done: items.reduce(
						(n, { card: c }) =>
							n + c.assignments.filter((a) => a.pulled || canPullAssignment(a)).length,
						0
					)
				};
			});
		}

		const sections = [
			{ label: '', groups: buildGroups(['commander', 'main']) },
			{ label: 'Sideboard', groups: buildGroups(['side']) },
			...(!ignoreMaybeboard ? [{ label: 'Maybeboard', groups: buildGroups(['maybe']) }] : [])
		];
		return sections.filter((s) => s.groups.length > 0);
	});

	// ── Unowned card lookup — drives indicators in Decklist + Table views ────────
	// Maps dcId → 'needed' | 'ordered' if ANY assignment for that card is unowned.
	// Uses displayBoards so optimistic patches are reflected immediately.
	const unownedStatusByDcId = $derived.by(() => {
		const m = new Map<number, 'needed' | 'ordered'>();
		for (const cards of Object.values(displayBoards)) {
			for (const card of cards) {
				let hasNeeded = false,
					hasOrdered = false;
				for (const a of card.assignments) {
					if (a.status === 'needed') hasNeeded = true;
					if (a.status === 'ordered') hasOrdered = true;
				}
				if (hasNeeded) m.set(card.dcId, 'needed');
				else if (hasOrdered) m.set(card.dcId, 'ordered');
			}
		}
		return m;
	});

	function generateDecklist(): string {
		return decklistGroups
			.map((group) => {
				const total = group.cards.reduce((s, c) => s + c.quantity, 0);
				const header = `// ${group.label} (${total})`;
				const lines = group.cards
					.slice()
					.sort((a, b) => a.cardName.localeCompare(b.cardName))
					.map((c) => {
						const setInfo =
							c.setCode && c.collectorNumber
								? ` (${c.setCode.toUpperCase()}) ${c.collectorNumber}`
								: '';
						return `${c.quantity} ${c.cardName}${setInfo}`;
					})
					.join('\n');
				return `${header}\n${lines}`;
			})
			.join('\n\n');
	}

	// Visual view: track which card IDs are showing their back face
	let flippedCards = $state<Set<number>>(new Set());
	function toggleFlip(id: number, e: MouseEvent) {
		e.preventDefault();
		const s = new Set(flippedCards);
		if (s.has(id)) s.delete(id);
		else s.add(id);
		flippedCards = s;
	}

	let copyFeedback = $state('');
	async function copyDecklist() {
		await navigator.clipboard.writeText(generateDecklist());
		copyFeedback = 'Copied!';
		setTimeout(() => (copyFeedback = ''), 2000);
	}

	async function mutateDeckCard(
		deckCardId: number,
		patch: { quantity?: number; board?: 'main' | 'side' | 'maybe' | 'commander' }
	): Promise<boolean> {
		deckMutationError = '';
		deckMutationMessage = '';
		try {
			const response = await fetch(`/api/deck-cards/${deckCardId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(patch)
			});
			const result = await response.json();
			if (!response.ok) {
				deckMutationError = result.error ?? 'Could not update this card.';
				return false;
			}
			if (result?.result) {
				applyDeckCardPatch(deckCardId, {
					...(typeof result.result.quantity === 'number' ? { quantity: result.result.quantity } : {})
				});
			}
			deckMutationMessage = 'Deck list updated.';
			await invalidateAll();
			return true;
		} catch {
			deckMutationError = 'Could not reach the server.';
			return false;
		}
	}

	function formatSyncTime(value: number | null): string {
		if (!value) return 'Never synced';
		return `Synced ${new Date(value).toLocaleString()}`;
	}

	// ── Per-card notes ────────────────────────────────────────────────────────
	let noteModal = $state<{ deckCardId: number; cardName: string; notes: string } | null>(null);
	let noteSaving = $state(false);

	async function saveNote() {
		if (!noteModal) return;
		noteSaving = true;
		await fetch(`/api/deck-cards/${noteModal.deckCardId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ notes: noteModal.notes })
		});
		noteSaving = false;
		noteModal = null;
		await invalidateAll();
	}

	// ── Inline proxy note editing ─────────────────────────────────────────────
	let inlineNoteId = $state<number | null>(null);
	let inlineNoteText = $state('');

	async function saveInlineNote(assignmentId: number) {
		// Optimistic update
		applyPatch(assignmentId, { note: inlineNoteText });
		inlineNoteId = null;

		await fetch(`/api/assignments/${assignmentId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ note: inlineNoteText })
		});
		// No invalidateAll — patch already updated the note in patchedBoards
	}
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">{data.deck.name}</h1>
		<p class="page-subtitle">
			{data.deck.format ?? 'No format'} · {data.deck.commander ?? 'No commander'}
			{#if data.deck.moxfieldUrl}
				· <a href={data.deck.moxfieldUrl} target="_blank" rel="noreferrer">Moxfield ↗</a>
			{/if}
			·
			<span class="deck-source-label"
				>{data.deck.sourceMode === 'moxfield' ? 'Moxfield managed' : 'Locally managed'}</span
			>
			{#if data.deck.sourceMode === 'moxfield'}
				· <span title={data.deck.lastSyncError ?? undefined}
					>{formatSyncTime(data.deck.lastSyncedAt)}</span
				>
			{/if}
		</p>
	</div>
	<div class="flex gap-2 deck-header-actions">
		<a href="/help#decks" class="btn">Help</a>
		<a href="/picklist?deck={data.deck.id}" class="btn btn-primary">Pick List</a>
		{#if data.deck.moxfieldUrl && data.deck.sourceMode === 'moxfield'}
			<form
				method="POST"
				action="?/syncDeck"
				use:enhance={() => {
					syncing = true;
					syncClientError = null;
					return async ({ result, update }) => {
						try {
							if (result.type === 'error') {
								// Unhandled server exception — don't let update() navigate to error page
								syncClientError =
									'Sync failed — server error. Check your Moxfield URL and try again.';
								return;
							}
							await update();
						} finally {
							syncing = false;
						}
					};
				}}
				style="display:inline"
			>
				<button type="submit" class="btn" disabled={syncing}>
					{syncing ? 'Syncing…' : 'Sync'}
				</button>
			</form>
		{/if}
		{#if data.deck.sourceMode === 'local'}
			<button class="btn" onclick={() => (editing = !editing)}>
				{editing ? 'Cancel' : 'Edit'}
			</button>
		{:else if !confirmConvert}
			<button class="btn" onclick={() => (confirmConvert = true)}>Make local</button>
		{:else}
			<span class="deck-confirm-text">Stop future Moxfield syncs?</span>
			<form method="POST" action="?/convertToLocal" use:enhance style="display:inline">
				<button type="submit" class="btn btn-danger">Confirm</button>
			</form>
			<button class="btn" onclick={() => (confirmConvert = false)}>Cancel</button>
		{/if}
		{#if !confirmArchive && !confirmDelete}
			<button class="btn" onclick={() => (confirmArchive = true)}>Archive</button>
			<button class="btn btn-danger" onclick={() => (confirmDelete = true)}>Delete</button>
		{:else if confirmArchive}
			<span style="font-size:13px;color:var(--text-muted)">Unassign all cards and archive?</span>
			<form method="POST" action="?/archiveDeck" use:enhance style="display:inline">
				<button type="submit" class="btn btn-danger">Confirm Archive</button>
			</form>
			<button class="btn" onclick={() => (confirmArchive = false)}>Cancel</button>
		{:else}
			<form method="POST" action="?/deleteDeck" use:enhance style="display:inline">
				<button type="submit" class="btn btn-danger">Confirm Delete</button>
			</form>
			<button class="btn" onclick={() => (confirmDelete = false)}>Cancel</button>
		{/if}
	</div>
</div>

{#if syncing}
	<div class="sync-progress" role="status" aria-live="polite">
		<div class="sync-progress-top">
			<strong>Syncing from Moxfield</strong>
			<span>Checking deck changes and keeping local assignment state intact.</span>
		</div>
		<div class="sync-progress-track" aria-hidden="true">
			<div class="sync-progress-bar"></div>
		</div>
		<div class="sync-progress-steps">
			{#each syncProgressSteps as step}
				<span>{step}</span>
			{/each}
		</div>
	</div>
{/if}

{#if deckMutationError}
	<div class="alert alert-error" role="alert">{deckMutationError}</div>
{:else if deckMutationMessage}
	<div class="alert alert-success" role="status">{deckMutationMessage}</div>
{/if}

{#if syncClientError}
	<div class="alert alert-error">✗ {syncClientError}</div>
{/if}
{#if form?.error}
	<div class="alert alert-error">✗ {form.error}</div>
{/if}
{#if data.pendingRemovals.length > 0}
	<div class="pending-removals" aria-live="polite">
		<div class="pending-removals-heading">
			<strong
				>{data.pendingRemovals.length}
				{data.pendingRemovals.length === 1 ? 'card' : 'cards'} to take out</strong
			>
			<span>Moxfield removed these packed copies. They remain reserved until you return them.</span>
		</div>
		{#each data.pendingRemovals as pending}
			<div class="pending-removal-row">
				<div class="pending-removal-copy">
					<strong>{pending.cardName}</strong>
					<span>
						{pending.currentQuantity} → {pending.targetQuantity}
						· return {pending.removeCount}
						{#if pending.packedCount > 0}
							· {pending.packedCount} packed{/if}
						{#if pending.proxyCount > 0}
							· {pending.proxyCount} proxy{/if}
					</span>
				</div>
				<div class="pending-removal-actions">
					<form
						method="POST"
						action="?/resolvePendingRemoval"
						use:enhance={() => {
							pendingBusyId = pending.id;
							return async ({ update }) => {
								try {
									await update();
								} finally {
									pendingBusyId = null;
								}
							};
						}}
					>
						<input type="hidden" name="pendingRemovalId" value={pending.id} />
						<input type="hidden" name="resolution" value="apply" />
						<button
							type="submit"
							class="btn btn-sm btn-danger"
							disabled={pendingBusyId === pending.id}
						>
							{pendingBusyId === pending.id ? 'Returning…' : 'Returned'}
						</button>
					</form>
				</div>
			</div>
		{/each}
	</div>
{/if}
{#if form?.success}
	<div class="alert alert-success">✓ Updated</div>
{/if}
{#if form?.syncResult}
	{@const r = form.syncResult}
	{@const parts = [
		r.added > 0 ? `${r.added} card${r.added !== 1 ? 's' : ''} added` : '',
		r.removed > 0 ? `${r.removed} removed` : '',
		r.updated > 0 ? `${r.updated} updated` : '',
		r.pending > 0 ? `${r.pending} pending removal${r.pending !== 1 ? 's' : ''}` : ''
	].filter(Boolean)}
	<div class="alert alert-success">
		✓ Sync complete —
		{#if parts.length > 0}{parts.join(', ')}{:else}already up to date{/if}
	</div>
{/if}

{#if editing}
	<div class="card mb-2">
		<form method="POST" action="?/updateDeck" use:enhance>
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
				<div class="form-group">
					<label for="edit-name">Deck Name</label>
					<input type="text" id="edit-name" name="name" value={data.deck.name} required />
				</div>
				<div class="form-group">
					<label for="edit-format">Format</label>
					<select id="edit-format" name="format">
						<option value="" selected={!data.deck.format}>—</option>
						{#each ['commander', 'standard', 'modern', 'legacy', 'pauper', 'vintage', 'pioneer'] as fmt}
							<option value={fmt} selected={data.deck.format === fmt}>{fmt}</option>
						{/each}
					</select>
				</div>
				<div class="form-group">
					<label for="edit-commander">Commander</label>
					<input
						type="text"
						id="edit-commander"
						name="commander"
						value={data.deck.commander ?? ''}
					/>
				</div>
				<div class="form-group">
					<label for="edit-notes">Notes</label>
					<input type="text" id="edit-notes" name="notes" value={data.deck.notes ?? ''} />
				</div>
			</div>
			<div class="flex gap-2">
				<button type="submit" class="btn btn-primary">Save</button>
				<button type="button" class="btn" onclick={() => (editing = false)}>Cancel</button>
			</div>
		</form>
	</div>
{/if}

<!-- Summary row (read-only) -->
<div
	style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--border)"
>
	<span style="font-size:14px;font-weight:700;white-space:nowrap">
		{deckStats.inDeck} / {deckStats.total} in deck
	</span>
	{#if deckStats.realCards > 0 || deckStats.proxy > 0}
		<span
			style="font-size:12px;color:var(--text-muted);border-left:1px solid var(--border);padding-left:12px;white-space:nowrap"
		>
			{#if deckStats.realCards > 0}<span style="color:var(--assigned)"
					>Real {deckStats.realCards}</span
				>{/if}
			{#if deckStats.proxy > 0}<span> &middot; </span><span style="color:var(--proxy)"
					>Proxy {deckStats.proxy}</span
				>{/if}
		</span>
	{/if}
	{#if deckStats.notPulled > 0}
		<span style="font-size:12px;color:var(--text-muted);white-space:nowrap"
			>{deckStats.notPulled} to pack</span
		>
	{/if}
	{#if deckStats.needsPrint > 0}
		<span style="font-size:12px;color:var(--warning);white-space:nowrap"
			>{deckStats.needsPrint} needs print</span
		>
	{/if}
	{#if deckStats.needed > 0}
		<span style="font-size:12px;color:var(--danger);white-space:nowrap"
			>{deckStats.needed} missing</span
		>
	{/if}
	{#if deckStats.unassigned > 0}
		<span style="font-size:12px;color:var(--text-muted);white-space:nowrap"
			>{deckStats.unassigned} unassigned</span
		>
	{/if}
	{#if deckStats.ordered > 0}
		<span style="font-size:12px;color:var(--text-muted);white-space:nowrap"
			>{deckStats.ordered} ordered</span
		>
	{/if}
	{#if deckStats.maybeCount > 0 && ignoreMaybeboard}
		<span
			style="font-size:11px;color:var(--text-muted);opacity:0.45;white-space:nowrap;margin-left:4px"
			>Maybeboard: {deckStats.maybeCount} ignored</span
		>
	{/if}
</div>

<!-- Workflow row (actions) -->
<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
	{#if deckStats.notPulled > 0}
		<form method="POST" action="?/pullAll" use:enhance style="display:inline">
			<button type="submit" class="btn btn-sm">Pack all ({deckStats.notPulled})</button>
		</form>
	{/if}
	{#if deckStats.inDeck > 0}
		<form method="POST" action="?/unPullAll" use:enhance style="display:inline">
			<button type="submit" class="btn btn-sm">Unpack all ({deckStats.inDeck})</button>
		</form>
	{/if}
	<form
		method="POST"
		action="?/autoAssign"
		use:enhance={() => {
			autoAssigning = true;
			return async ({ update }) => {
				await update();
				autoAssigning = false;
			};
		}}
		style="display:inline"
	>
		<button type="submit" class="btn btn-sm" disabled={autoAssigning}>
			{autoAssigning ? 'Assigning…' : 'Auto-assign'}
		</button>
	</form>
	<form method="POST" action="?/resetAssignments" use:enhance style="display:inline">
		<button type="submit" class="btn btn-sm btn-danger">Reset</button>
	</form>
</div>

<!-- View mode tabs -->
<div class="tabs" style="margin-bottom:16px">
	<button class="tab" class:active={viewMode === 'manager'} onclick={() => (viewMode = 'manager')}
		>Manager</button
	>
	<button class="tab" class:active={viewMode === 'table'} onclick={() => (viewMode = 'table')}
		>Table</button
	>
	<button class="tab" class:active={viewMode === 'decklist'} onclick={() => (viewMode = 'decklist')}
		>Decklist</button
	>
	<button class="tab" class:active={viewMode === 'visual'} onclick={() => (viewMode = 'visual')}
		>Visual</button
	>
	<button class="tab" class:active={viewMode === 'board'} onclick={() => (viewMode = 'board')}
		>Board</button
	>
</div>

<!-- Manager view -->
{#if viewMode === 'manager'}
	<ManagerView
		{boardViewGroups}
		{patchAssignment}
		{patchPrintStatus}
		{applyPatch}
		bind:filterSearch
		bind:hiddenStatuses
		openNoteModal={(deckCardId, cardName, notes) => (noteModal = { deckCardId, cardName, notes })}
		canEditDeck={false}
		{mutateDeckCard}
	/>
{/if}

<!-- Table view -->
{#if viewMode === 'table'}
	<!-- Filter toolbar -->
	<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
		<input
			type="search"
			placeholder="Search cards…"
			bind:value={filterSearch}
			style="padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;min-width:180px"
		/>
		<button
			class="btn btn-sm"
			class:btn-primary={bulkMode}
			onclick={() => {
				bulkMode = !bulkMode;
				if (!bulkMode) bulkSelected = new Set();
			}}
		>
			{bulkMode ? 'Cancel' : 'Bulk edit'}
		</button>
		{#if filterSearch || hiddenStatuses.size > 0}
			<button
				class="btn btn-sm"
				onclick={() => {
					filterSearch = '';
					hiddenStatuses = new Set();
				}}>Clear filters</button
			>
		{/if}
	</div>
	<!-- Status toggle chips: click a status to hide/show it (uses all boards for accurate counts) -->
	<div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
		<span style="font-size:12px;color:var(--text-muted);white-space:nowrap">Hide:</span>
		{#each Object.entries(STATUS_LABELS) as [status, label]}
			{#if (allStatMap[status] ?? 0) > 0}
				<button
					class="btn btn-sm badge {STATUS_CLASSES[status] ?? ''}"
					style={hiddenStatuses.has(status) ? 'opacity:0.4;text-decoration:line-through' : ''}
					onclick={() => toggleHideStatus(status)}
					title={hiddenStatuses.has(status) ? `Show ${label}` : `Hide ${label}`}
					>{allStatMap[status]} {label}</button
				>
			{/if}
		{/each}
	</div>

	<!-- Bulk action bar -->
	{#if bulkMode && bulkSelected.size > 0}
		<div
			style="display:flex;gap:6px;align-items:center;margin-bottom:6px;padding:8px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;flex-wrap:wrap"
		>
			<span class="text-sm" style="color:var(--accent);font-weight:600;margin-right:4px"
				>{bulkSelected.size} selected</span
			>
			<button
				class="act-chip act-chip-pull"
				onclick={() => runBulkAction('pull')}
				disabled={bulkLoading}>Pull</button
			>
			<button class="act-chip" onclick={() => runBulkAction('unpull')} disabled={bulkLoading}
				>Unpull</button
			>
			<button class="act-chip" onclick={() => runBulkAction('unassign')} disabled={bulkLoading}
				>Unassign</button
			>
			<button
				class="act-chip act-chip-order"
				onclick={() => runBulkAction('order')}
				disabled={bulkLoading}>Order</button
			>
			<button class="act-chip" onclick={() => runBulkAction('proxied')} disabled={bulkLoading}
				>Proxy</button
			>
			<button class="act-chip" onclick={() => runBulkAction('autoAssign')} disabled={bulkLoading}
				>Auto-assign</button
			>
			<button
				class="act-chip"
				class:act-chip-pull={bulkSetInput}
				onclick={() => {
					bulkSetInput = !bulkSetInput;
					bulkSetResult = null;
					bulkSetCode = '';
				}}
				disabled={bulkLoading}>From set…</button
			>
			<button
				class="btn btn-sm"
				style="margin-left:auto"
				onclick={() => {
					bulkSelected = new Set();
					bulkSetInput = false;
					bulkSetResult = null;
				}}>Deselect all</button
			>
		</div>
		<!-- From-set input row -->
		{#if bulkSetInput}
			<div
				style="display:flex;gap:8px;align-items:center;margin-bottom:6px;padding:8px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;flex-wrap:wrap"
			>
				<span style="font-size:13px;color:var(--text-muted)">Set code:</span>
				<input
					type="text"
					placeholder="e.g. c24, one, mh3"
					bind:value={bulkSetCode}
					style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;font-family:monospace;width:140px"
					onkeydown={(e) => {
						if (e.key === 'Enter') runBulkLinkFromSet();
					}}
				/>
				<button
					class="btn btn-sm btn-primary"
					onclick={runBulkLinkFromSet}
					disabled={bulkSetLoading || !bulkSetCode.trim()}
				>
					{bulkSetLoading ? 'Linking…' : 'Link copies'}
				</button>
				{#if bulkSetResult}
					<span style="font-size:12px;color:var(--text-muted)">
						{#if bulkSetResult.linked > 0}<span style="color:var(--success)"
								>✓ {bulkSetResult.linked} linked</span
							>{/if}
						{#if bulkSetResult.notFound > 0}<span style="color:var(--error);margin-left:6px"
								>✗ {bulkSetResult.notFound} not in collection</span
							>{/if}
						{#if bulkSetResult.unavailable > 0}<span style="color:var(--warning);margin-left:6px"
								>⚠ {bulkSetResult.unavailable} no copies available</span
							>{/if}
					</span>
				{/if}
			</div>
		{/if}
	{/if}

	{#each BOARD_ORDER as board}
		{#if displayBoards[board]?.length}
			{@const boardCards = displayBoards[board]}
			{@const basicCards = boardCards.filter(isBasicLand)}
			{@const nonBasicCards = boardCards.filter((c) => !isBasicLand(c))}
			{@const collapsed = basicsCollapsed[board] ?? false}
			<div class="picklist-section">
				<div class="picklist-group">
					<div class="picklist-section-header" style="display:flex;align-items:center;gap:10px">
						<span>
							{BOARD_LABELS[board] ?? board}
							<span class="text-muted text-sm" style="font-weight: 400">
								({boardCards.reduce((s, c) => s + c.quantity, 0)} cards)
							</span>
						</span>
						{#if basicCards.length > 0}
							<button
								class="btn btn-sm"
								style="font-size:11px;padding:2px 8px;margin-left:auto"
								onclick={() => (basicsCollapsed = { ...basicsCollapsed, [board]: !collapsed })}
							>
								{collapsed ? '▶ Show basics' : '▼ Hide basics'} ({basicCards.reduce(
									(s, c) => s + c.quantity,
									0
								)})
							</button>
							{#if collapsed}
								<button
									class="btn btn-sm"
									style="font-size:11px;padding:2px 8px"
									onclick={() => markBasicsAs(board, 'proxied')}>Proxy basics</button
								>
							{/if}
						{/if}
					</div>
					<table class="data-table">
						<thead>
							<tr>
								{#if bulkMode}
									<th style="width:32px;padding:4px 6px">
										<input
											type="checkbox"
											checked={isBoardAllSelected(board)}
											onchange={() => toggleBoardSelect(board)}
											title="Select all in board"
										/>
									</th>
								{/if}
								<th
									style="cursor:pointer;user-select:none;width:28%"
									onclick={() => toggleSort(board, 'name')}
								>
									Card {sortIcon(board, 'name')}
								</th>
								<th
									style="cursor:pointer;user-select:none"
									onclick={() => toggleSort(board, 'copy')}
								>
									Assigned Copy {sortIcon(board, 'copy')}
								</th>
								<th
									style="cursor:pointer;user-select:none"
									onclick={() => toggleSort(board, 'cmc')}
								>
									CMC {sortIcon(board, 'cmc')}
								</th>
								<th
									style="cursor:pointer;user-select:none"
									onclick={() => toggleSort(board, 'status')}
								>
									Status {sortIcon(board, 'status')}
								</th>
								<th
									style="cursor:pointer;user-select:none"
									onclick={() => toggleSort(board, 'location')}
								>
									Location {sortIcon(board, 'location')}
								</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each collapsed ? nonBasicCards : boardCards as card}
								{#each card.assignments as assignment, idx}
									<tr
										style={assignment.status === 'needed' || assignment.status === 'ordered'
											? 'background:color-mix(in srgb,var(--warning) 5%,var(--surface))'
											: ''}
									>
										{#if bulkMode}
											<td style="padding:4px 6px">
												{#if idx === 0}
													<input
														type="checkbox"
														checked={card.assignments.every((a) => bulkSelected.has(a.id))}
														onchange={() => {
															for (const a of card.assignments) toggleBulk(a.id);
														}}
													/>
												{/if}
											</td>
										{/if}
										<td>
											{#if idx === 0}
												<CardImage
													imageUri={assignment.imageUri ?? card.fallbackImageUri ?? null}
													name={card.cardName}
												>
													<a
														href="/cards/{encodeURIComponent(card.cardName)}"
														class="picklist-card-name card-link">{card.cardName}</a
													>
												</CardImage>
												{#if card.quantity > 1}
													<span class="text-muted text-sm">×{card.quantity}</span>
												{/if}
												{#if card.notes}
													<div
														style="font-size:12px;color:var(--text-muted);font-style:italic;margin-top:3px;max-width:260px;white-space:pre-wrap"
													>
														{card.notes}
													</div>
												{/if}
											{:else}
												<span class="text-muted text-sm" style="padding-left:12px"
													>↳ copy {idx + 1}</span
												>
											{/if}
										</td>
										<td class="mono text-sm">
											{#if assignment.collSetCode}
												<!-- Assigned copy button — click to open inline dropdown -->
												<div style="position:relative;display:inline-block">
													<button
														class="btn btn-sm"
														style="text-align:left;font-family:monospace;padding:2px 6px"
														onclick={() => openCopyDropdown(assignment.id)}
														title="Click to change printing"
													>
														{assignment.collSetCode.toUpperCase()} #{assignment.collCollectorNumber}
														{#if assignment.collFoil}<span
																class="text-muted"
																style="font-size:10px"
															>
																(F)</span
															>{/if}
														<span class="text-muted">({assignment.collCondition})</span>
														<span class="text-muted" style="font-size:10px;margin-left:4px">✎</span>
													</button>
													{#if copyDropdownId === assignment.id}
														<div
															style="position:absolute;left:0;top:100%;z-index:50;background:var(--surface);border:1px solid var(--border);border-radius:6px;min-width:220px;box-shadow:0 4px 16px rgba(0,0,0,0.25);padding:6px 0"
														>
															{#if copyDropdownLoading && !copyDropdownCache.has(assignment.id)}
																<div
																	style="padding:8px 12px;font-size:12px;color:var(--text-muted)"
																>
																	Loading…
																</div>
															{:else}
																{#each copyDropdownCache.get(assignment.id) ?? [] as copy}
																	{@const isCurrent = copy.id === assignment.collectionId}
																	{@const canAssign = copy.available > 0 || isCurrent}
																	<button
																		style="display:flex;width:100%;align-items:center;justify-content:space-between;padding:6px 12px;background:none;border:none;cursor:{canAssign
																			? 'pointer'
																			: 'not-allowed'};opacity:{canAssign
																			? 1
																			: 0.45};font-size:12px;color:var(--text);text-align:left"
																		disabled={!canAssign}
																		onclick={async () => {
																			copyDropdownId = null;
																			const status = 'assigned';
																			await patchAssignment(assignment.id, {
																				status: status,
																				collectionId: copy.id
																			});
																		}}
																	>
																		<span>
																			<span style="font-family:monospace"
																				>{copy.setCode.toUpperCase()} #{copy.collectorNumber}</span
																			>
																			{#if copy.foil}<span
																					class="text-muted"
																					style="font-size:10px"
																				>
																					(F)</span
																				>{/if}
																			{#if isCurrent}<span style="color:var(--accent)">
																					✓</span
																				>{/if}
																		</span>
																		<span
																			style="color:{copy.available > 0
																				? 'var(--text-muted)'
																				: 'var(--error)'}"
																		>
																			{copy.available}/{copy.quantity}</span
																		>
																	</button>
																	{#if !canAssign && copy.conflicts.length > 0}
																		<div
																			style="padding:2px 12px 6px 20px;font-size:11px;color:var(--text-muted)"
																		>
																			{#each copy.conflicts as c}
																				<div>↳ {c.deckName} ({c.status})</div>
																			{/each}
																			<button
																				style="margin-top:3px;padding:2px 8px;font-size:11px;background:none;border:1px solid var(--warning);border-radius:4px;cursor:pointer;color:var(--warning)"
																				onclick={async () => {
																					copyDropdownId = null;
																					const status = 'assigned';
																					await patchAssignment(assignment.id, {
																						status: status,
																						collectionId: copy.id,
																						override: true
																					});
																				}}>Override</button
																			>
																		</div>
																	{/if}
																{/each}
																<hr
																	style="margin:4px 0;border:none;border-top:1px solid var(--border)"
																/>
																<button
																	style="display:block;width:100%;padding:5px 12px;background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-muted);text-align:left"
																	onclick={() => {
																		copyDropdownId = null;
																		patchAssignment(assignment.id, {
																			status: 'proxied',
																			collectionId: null
																		});
																	}}>Mark as Proxy</button
																>
																<button
																	style="display:block;width:100%;padding:5px 12px;background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-muted);text-align:left"
																	onclick={() => {
																		copyDropdownId = null;
																		patchAssignment(assignment.id, {
																			status: 'needed',
																			collectionId: null
																		});
																	}}>✕ Unassign</button
																>
															{/if}
														</div>
													{/if}
												</div>
											{:else if assignment.proxySetCode}
												<span class="text-muted"
													>{assignment.proxySetCode.toUpperCase()} #{assignment.proxyCollectorNumber}</span
												>
											{:else if assignment.status === 'proxied'}
												{#if inlineNoteId === assignment.id}
													<input
														type="text"
														value={inlineNoteText}
														placeholder="e.g. fullart custom"
														style="font-size:12px;padding:2px 6px;border:1px solid var(--accent);border-radius:4px;background:var(--surface);color:var(--text);width:160px"
														use:focusOnMount
														oninput={(e) => (inlineNoteText = (e.target as HTMLInputElement).value)}
														onblur={() => saveInlineNote(assignment.id)}
														onkeydown={(e) => {
															if (e.key === 'Enter') saveInlineNote(assignment.id);
															if (e.key === 'Escape') {
																inlineNoteId = null;
															}
														}}
													/>
												{:else}
													<button
														class="btn btn-sm"
														style="color:var(--text-muted);font-style:italic;padding:2px 6px"
														title="Click to add proxy note"
														onclick={() => {
															inlineNoteId = assignment.id;
															inlineNoteText = assignment.note ?? '';
														}}>{assignment.note ? assignment.note : '+ add note…'}</button
													>
												{/if}
												<!-- Proxy without a linked printing — can link one -->
												<div style="position:relative;display:inline-block">
													<button
														class="btn btn-sm"
														style="color:var(--text-muted)"
														onclick={() => openCopyDropdown(assignment.id)}
														title="Link a printing for this proxy"
													>
														Link copy… ✎
													</button>
													{#if copyDropdownId === assignment.id}
														<div
															style="position:absolute;left:0;top:100%;z-index:50;background:var(--surface);border:1px solid var(--border);border-radius:6px;min-width:220px;box-shadow:0 4px 16px rgba(0,0,0,0.25);padding:6px 0"
														>
															{#if copyDropdownLoading && !copyDropdownCache.has(assignment.id)}
																<div
																	style="padding:8px 12px;font-size:12px;color:var(--text-muted)"
																>
																	Loading…
																</div>
															{:else if (copyDropdownCache.get(assignment.id) ?? []).length === 0}
																<div
																	style="padding:8px 12px;font-size:12px;color:var(--text-muted)"
																>
																	No copies in collection
																</div>
															{:else}
																{#each copyDropdownCache.get(assignment.id) ?? [] as copy}
																	{@const canAssign = copy.available > 0}
																	<button
																		style="display:flex;width:100%;align-items:center;justify-content:space-between;padding:6px 12px;background:none;border:none;cursor:{canAssign
																			? 'pointer'
																			: 'not-allowed'};opacity:{canAssign
																			? 1
																			: 0.45};font-size:12px;color:var(--text);text-align:left"
																		disabled={!canAssign}
																		onclick={async () => {
																			copyDropdownId = null;
																			await patchAssignment(assignment.id, {
																				status: 'assigned',
																				collectionId: copy.id
																			});
																		}}
																	>
																		<span style="font-family:monospace"
																			>{copy.setCode.toUpperCase()} #{copy.collectorNumber}{#if copy.foil}<span
																					class="text-muted"
																					style="font-size:10px"
																				>
																					(F)</span
																				>{/if}</span
																		>
																		<span
																			style="color:{copy.available > 0
																				? 'var(--text-muted)'
																				: 'var(--error)'}"
																		>
																			{copy.available}/{copy.quantity}</span
																		>
																	</button>
																	{#if !canAssign && copy.conflicts.length > 0}
																		<div
																			style="padding:2px 12px 6px 20px;font-size:11px;color:var(--text-muted)"
																		>
																			{#each copy.conflicts as c}
																				<div>↳ {c.deckName} ({c.status})</div>
																			{/each}
																			<button
																				style="margin-top:3px;padding:2px 8px;font-size:11px;background:none;border:1px solid var(--warning);border-radius:4px;cursor:pointer;color:var(--warning)"
																				onclick={async () => {
																					copyDropdownId = null;
																					await patchAssignment(assignment.id, {
																						status: 'assigned',
																						collectionId: copy.id,
																						override: true
																					});
																				}}>Override</button
																			>
																		</div>
																	{/if}
																{/each}
															{/if}
														</div>
													{/if}
												</div>
											{:else if assignment.pulled && !assignment.collectionId}
												<!-- Pulled proxy — clickable to reassign without unpulling -->
												<div style="position:relative;display:inline-block">
													<button
														class="btn btn-sm"
														style="color:var(--text-muted);font-style:italic"
														onclick={() => openCopyDropdown(assignment.id)}
														title="Click to change assignment"
													>
														Proxy{#if assignment.note}
															— {assignment.note}{/if}
														<span style="font-size:10px;margin-left:4px">✎</span>
													</button>
													{#if copyDropdownId === assignment.id}
														<div
															style="position:absolute;left:0;top:100%;z-index:50;background:var(--surface);border:1px solid var(--border);border-radius:6px;min-width:220px;box-shadow:0 4px 16px rgba(0,0,0,0.25);padding:6px 0"
														>
															{#if copyDropdownLoading && !copyDropdownCache.has(assignment.id)}
																<div
																	style="padding:8px 12px;font-size:12px;color:var(--text-muted)"
																>
																	Loading…
																</div>
															{:else if (copyDropdownCache.get(assignment.id) ?? []).length === 0}
																<div
																	style="padding:8px 12px;font-size:12px;color:var(--text-muted)"
																>
																	Not in collection
																</div>
															{:else}
																{#each copyDropdownCache.get(assignment.id) ?? [] as copy}
																	{@const canAssign = copy.available > 0}
																	<button
																		style="display:flex;width:100%;align-items:center;justify-content:space-between;padding:6px 12px;background:none;border:none;cursor:{canAssign
																			? 'pointer'
																			: 'not-allowed'};opacity:{canAssign
																			? 1
																			: 0.45};font-size:12px;color:var(--text);text-align:left"
																		disabled={!canAssign}
																		onclick={async () => {
																			copyDropdownId = null;
																			const status = 'assigned';
																			await patchAssignment(assignment.id, {
																				status,
																				collectionId: copy.id,
																				pulled: true
																			});
																		}}
																	>
																		<span style="font-family:monospace"
																			>{copy.setCode.toUpperCase()} #{copy.collectorNumber}{#if copy.foil}<span
																					class="text-muted"
																					style="font-size:10px"
																				>
																					(F)</span
																				>{/if}</span
																		>
																		<span
																			style="color:{copy.available > 0
																				? 'var(--text-muted)'
																				: 'var(--error)'}"
																		>
																			{copy.available}/{copy.quantity}</span
																		>
																	</button>
																	{#if !canAssign && copy.conflicts.length > 0}
																		<div
																			style="padding:2px 12px 6px 20px;font-size:11px;color:var(--text-muted)"
																		>
																			{#each copy.conflicts as c}
																				<div>↳ {c.deckName} ({c.status})</div>
																			{/each}
																			<button
																				style="margin-top:3px;padding:2px 8px;font-size:11px;background:none;border:1px solid var(--warning);border-radius:4px;cursor:pointer;color:var(--warning)"
																				onclick={async () => {
																					copyDropdownId = null;
																					const status = 'assigned';
																					await patchAssignment(assignment.id, {
																						status,
																						collectionId: copy.id,
																						override: true,
																						pulled: true
																					});
																				}}>Override</button
																			>
																		</div>
																	{/if}
																{/each}
															{/if}
															<hr
																style="margin:4px 0;border:none;border-top:1px solid var(--border)"
															/>
															<button
																style="display:block;width:100%;padding:5px 12px;background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-muted);text-align:left"
																onclick={() => {
																	copyDropdownId = null;
																	patchAssignment(assignment.id, {
																		status: 'proxied',
																		collectionId: null
																	});
																}}>Mark as Proxy</button
															>
															<button
																style="display:block;width:100%;padding:5px 12px;background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-muted);text-align:left"
																onclick={() => {
																	copyDropdownId = null;
																	patchAssignment(assignment.id, {
																		status: 'needed',
																		collectionId: null
																	});
																}}>✕ Unassign</button
															>
														</div>
													{/if}
												</div>
											{:else}
												<!-- Needed/ordered — choose copy -->
												<div style="position:relative;display:inline-block">
													<button
														class="btn btn-sm"
														style="color: var(--accent)"
														onclick={() => openCopyDropdown(assignment.id)}
													>
														Assign copy…
													</button>
													{#if copyDropdownId === assignment.id}
														<div
															style="position:absolute;left:0;top:100%;z-index:50;background:var(--surface);border:1px solid var(--border);border-radius:6px;min-width:220px;box-shadow:0 4px 16px rgba(0,0,0,0.25);padding:6px 0"
														>
															{#if copyDropdownLoading && !copyDropdownCache.has(assignment.id)}
																<div
																	style="padding:8px 12px;font-size:12px;color:var(--text-muted)"
																>
																	Loading…
																</div>
															{:else if (copyDropdownCache.get(assignment.id) ?? []).length === 0}
																<div
																	style="padding:8px 12px;font-size:12px;color:var(--text-muted)"
																>
																	Not in collection
																</div>
																<hr
																	style="margin:4px 0;border:none;border-top:1px solid var(--border)"
																/>
																<button
																	style="display:block;width:100%;padding:5px 12px;background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-muted);text-align:left"
																	onclick={() => {
																		copyDropdownId = null;
																		patchAssignment(assignment.id, {
																			status: 'proxied',
																			collectionId: null
																		});
																	}}>Proxy</button
																>
															{:else}
																{#each copyDropdownCache.get(assignment.id) ?? [] as copy}
																	{@const canAssign = copy.available > 0}
																	<button
																		style="display:flex;width:100%;align-items:center;justify-content:space-between;padding:6px 12px;background:none;border:none;cursor:{canAssign
																			? 'pointer'
																			: 'not-allowed'};opacity:{canAssign
																			? 1
																			: 0.45};font-size:12px;color:var(--text);text-align:left"
																		disabled={!canAssign}
																		onclick={async () => {
																			copyDropdownId = null;
																			const status = 'assigned';
																			await patchAssignment(assignment.id, {
																				status: status,
																				collectionId: copy.id
																			});
																		}}
																	>
																		<span>
																			<span style="font-family:monospace"
																				>{copy.setCode.toUpperCase()} #{copy.collectorNumber}</span
																			>
																			{#if copy.foil}<span
																					class="text-muted"
																					style="font-size:10px"
																				>
																					(F)</span
																				>{/if}
																		</span>
																		<span
																			style="color:{copy.available > 0
																				? 'var(--text-muted)'
																				: 'var(--error)'}"
																		>
																			{copy.available}/{copy.quantity}</span
																		>
																	</button>
																	{#if !canAssign && copy.conflicts.length > 0}
																		<div
																			style="padding:2px 12px 6px 20px;font-size:11px;color:var(--text-muted)"
																		>
																			{#each copy.conflicts as c}
																				<div>↳ {c.deckName} ({c.status})</div>
																			{/each}
																			<button
																				style="margin-top:3px;padding:2px 8px;font-size:11px;background:none;border:1px solid var(--warning);border-radius:4px;cursor:pointer;color:var(--warning)"
																				onclick={async () => {
																					copyDropdownId = null;
																					const status = 'assigned';
																					await patchAssignment(assignment.id, {
																						status: status,
																						collectionId: copy.id,
																						override: true
																					});
																				}}>Override</button
																			>
																		</div>
																	{/if}
																{/each}
																<hr
																	style="margin:4px 0;border:none;border-top:1px solid var(--border)"
																/>
																<button
																	style="display:block;width:100%;padding:5px 12px;background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-muted);text-align:left"
																	onclick={() => {
																		copyDropdownId = null;
																		patchAssignment(assignment.id, {
																			status: 'proxied',
																			collectionId: null
																		});
																	}}>Proxy instead</button
																>
															{/if}
														</div>
													{/if}
												</div>
											{/if}
										</td>
										<td class="text-muted">{assignment.cmc ?? '—'}</td>
										<td>
											<span
												style="display:inline-flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap"
											>
												<span class="status-dot status-dot-{displayStatus(assignment.status)}"
												></span>
												<span style="color:var(--text-muted)"
													>{STATUS_LABELS[displayStatus(assignment.status)] ??
														displayStatus(assignment.status)}</span
												>
											</span>
										</td>
										<td>
											{#if assignment.location}
												<span class="loc-chip loc-{assignment.location}">
													{displayLocation(assignment.location)}
												</span>
											{:else}
												<span class="text-muted">—</span>
											{/if}
										</td>
										<td>
											<div class="flex gap-1" style="flex-wrap:wrap">
												{#if canPullAssignment(assignment) && !assignment.pulled}
													<button
														class="act-chip act-chip-pull"
														onclick={() => patchAssignment(assignment.id, { pulled: true })}
														>Pull</button
													>
												{/if}
												{#if assignment.pulled}
													<button
														class="act-chip"
														onclick={() => patchAssignment(assignment.id, { pulled: false })}
														>Unpull</button
													>
												{/if}
												{#if assignment.status === 'needed'}
													<button
														class="act-chip act-chip-order"
														onclick={() => patchAssignment(assignment.id, { status: 'ordered' })}
														>Order</button
													>
												{/if}
												{#if assignment.status === 'needed' || assignment.status === 'ordered'}
													<button
														class="act-chip"
														onclick={() => patchAssignment(assignment.id, { status: 'proxied' })}
														>Proxy</button
													>
												{/if}
												{#if assignment.status === 'proxied'}
													{@const effectivePrint = effectiveProxyPrintStatus(assignment)}
													{#if effectivePrint}
														<span
															style="font-size:10px;font-weight:600;color:{effectivePrint ===
															'need_reprint'
																? 'var(--error)'
																: 'var(--warning)'}"
														>
															{effectivePrint === 'need_reprint' ? 'Reprint' : 'Print'}
														</span>
														<button
															class="act-chip"
															style="font-size:10px;padding:1px 5px"
															title="Clear print status"
															onclick={() => patchPrintStatus(assignment.id, null)}>✕</button
														>
													{:else}
														<button
															class="act-chip"
															style="font-size:10px;color:var(--warning)"
															onclick={() => patchPrintStatus(assignment.id, 'need_print')}
															>Need Print</button
														>
														<button
															class="act-chip"
															style="font-size:10px;color:var(--error)"
															onclick={() => patchPrintStatus(assignment.id, 'need_reprint')}
															>Need Reprint</button
														>
													{/if}
												{/if}
												{#if assignment.status !== 'needed'}
													<button
														class="act-chip act-chip-reset"
														onclick={() => patchAssignment(assignment.id, { status: 'needed' })}
														>Reset</button
													>
												{/if}
												{#if idx === 0}
													<button
														class="act-chip act-chip-note"
														class:has-note={card.notes}
														onclick={() =>
															(noteModal = {
																deckCardId: card.dcId,
																cardName: card.cardName,
																notes: card.notes ?? ''
															})}>{card.notes ? 'Note ✎' : 'Note'}</button
													>
												{/if}
											</div>
										</td>
									</tr>
								{/each}
							{/each}
							{#if collapsed && basicCards.length > 0}
								<tr>
									<td
										colspan={bulkMode ? 7 : 6}
										style="padding:8px 12px;color:var(--text-muted);font-size:12px;font-style:italic"
									>
										{basicCards.reduce((s, c) => s + c.quantity, 0)} basic land{basicCards.reduce(
											(s, c) => s + c.quantity,
											0
										) !== 1
											? 's'
											: ''} hidden —
										<button
											class="btn btn-sm"
											style="font-size:11px;padding:1px 6px"
											onclick={() => (basicsCollapsed = { ...basicsCollapsed, [board]: false })}
											>show</button
										>
									</td>
								</tr>
							{/if}
						</tbody>
					</table>
				</div>
			</div>
		{/if}
	{/each}
{/if}

<!-- Decklist view -->
{#if viewMode === 'decklist'}
	<div class="card">
		<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
			<span class="text-muted text-sm"
				>{data.deckCardsEnriched.reduce((s, c) => s + c.quantity, 0)} cards</span
			>
			<button class="btn btn-sm" onclick={copyDecklist}>{copyFeedback || 'Copy'}</button>
		</div>
		{#each decklistGroups as group}
			{@const total = group.cards.reduce((s, c) => s + c.quantity, 0)}
			<div style="margin-bottom:16px">
				<div
					style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--border)"
				>
					{group.label} ({total})
				</div>
				{#each group.cards.slice().sort((a, b) => a.cardName.localeCompare(b.cardName)) as card}
					{@const unownedStatus = unownedStatusByDcId.get(card.id)}
					<div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:13px">
						<span style="color:var(--text-muted);min-width:20px;text-align:right"
							>{card.quantity}</span
						>
						<CardImage imageUri={card.imageUri ?? null} name={card.cardName}>
							<a
								href="/cards/{encodeURIComponent(card.cardName)}"
								class="card-link"
								style="font-weight:500">{card.cardName}</a
							>
						</CardImage>
						{#if unownedStatus}
							<span
								class="status-dot status-dot-{unownedStatus}"
								title={unownedStatus === 'ordered'
									? 'Ordered — not yet in collection'
									: 'Not in collection'}
								style="flex-shrink:0"
							></span>
						{/if}
						{#if card.setCode && card.collectorNumber}
							<span class="mono text-muted text-sm"
								>{card.setCode.toUpperCase()} #{card.collectorNumber}</span
							>
						{:else if card.setCode}
							<span class="mono text-muted text-sm">{card.setCode.toUpperCase()}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/each}
	</div>
{/if}

<!-- Visual view -->
{#if viewMode === 'visual'}
	{#each decklistGroups as group}
		{@const total = group.cards.reduce((s, c) => s + c.quantity, 0)}
		<div style="margin-bottom:24px">
			<div
				style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:8px"
			>
				{group.label} ({total})
			</div>
			<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px">
				{#each group.cards as card}
					{@const isFlipped = flippedCards.has(card.id)}
					{@const displayUri = isFlipped && card.backImageUri ? card.backImageUri : card.imageUri}
					<div style="position:relative;text-align:center">
						<a
							href="/cards/{encodeURIComponent(card.cardName)}"
							style="display:block;text-decoration:none;color:inherit"
						>
							{#if displayUri}
								<img
									src={displayUri}
									alt={card.cardName}
									style="width:100%;border-radius:6px;display:block"
									title={card.cardName}
								/>
							{:else}
								<div
									style="aspect-ratio:63/88;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--text-muted);padding:4px;text-align:center"
								>
									{card.cardName}
								</div>
							{/if}
							{#if card.quantity > 1}
								<div style="font-size:11px;color:var(--text-muted);margin-top:2px">
									×{card.quantity}
								</div>
							{/if}
						</a>
						{#if card.backImageUri}
							<button
								onclick={(e) => toggleFlip(card.id, e)}
								title={isFlipped ? 'Show front face' : 'Show back face'}
								style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.55);border:none;border-radius:50%;width:24px;height:24px;font-size:13px;line-height:24px;text-align:center;cursor:pointer;padding:0;color:#fff"
								>↻</button
							>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/each}
{/if}

<!-- Board / compact multi-column view -->
{#if viewMode === 'board'}
	<!-- Same search + status filter toolbar as table view -->
	<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
		<input
			type="search"
			placeholder="Search cards…"
			bind:value={filterSearch}
			style="padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;min-width:180px"
		/>
		{#if filterSearch || hiddenStatuses.size > 0}
			<button
				class="btn btn-sm"
				onclick={() => {
					filterSearch = '';
					hiddenStatuses = new Set();
				}}>Clear filters</button
			>
		{/if}
	</div>
	<div style="display:flex;gap:6px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
		<span style="font-size:12px;color:var(--text-muted);white-space:nowrap">Hide:</span>
		{#each Object.entries(STATUS_LABELS) as [status, label]}
			{#if displayedStatusCount(status) > 0}
				<button
					class="btn btn-sm badge {STATUS_CLASSES[status] ?? ''}"
					style={hiddenStatuses.has(status) ? 'opacity:0.4;text-decoration:line-through' : ''}
					onclick={() => toggleHideStatus(status)}>{displayedStatusCount(status)} {label}</button
				>
			{/if}
		{/each}
	</div>

	<!-- Multi-column card type groups, separated by board section -->
	{#each boardViewGroups as section}
		{#if section.label}
			<div
				style="display:flex;align-items:center;gap:8px;margin:16px 0 10px;color:var(--text-muted)"
			>
				<hr style="flex:1;border:none;border-top:1px solid var(--border);margin:0" />
				<span
					style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap"
					>{section.label}</span
				>
				<hr style="flex:1;border:none;border-top:1px solid var(--border);margin:0" />
			</div>
		{/if}
		<div style="column-width:260px;column-gap:12px">
			{#each section.groups as group}
				<div
					style="break-inside:avoid;margin-bottom:12px;border:1px solid var(--border);border-radius:8px;overflow:hidden"
				>
					<!-- Group header with done/total count -->
					<div
						style="display:flex;align-items:center;justify-content:space-between;padding:5px 10px;background:var(--surface-2);border-bottom:1px solid var(--border)"
					>
						<span
							style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)"
							>{group.label}</span
						>
						<span
							style="font-size:11px;color:{group.done === group.total
								? 'var(--success)'
								: 'var(--text-muted)'};font-weight:600">{group.done}/{group.total}</span
						>
					</div>
					<!-- Card rows -->
					{#each group.items as { card }}
						{@const firstCopy = card.assignments.find((a) => a.collSetCode)}
						<div
							style="display:flex;align-items:center;gap:5px;padding:3px 8px;border-bottom:1px solid color-mix(in srgb, var(--border) 50%, transparent);min-height:24px"
						>
							<!-- Status dots — one per assignment -->
							<div style="display:flex;gap:2px;align-items:center;flex-shrink:0">
								{#each card.assignments as a}
									<span
										style="display:inline-block;width:7px;height:7px;border-radius:50%;background:{STATUS_DOT_COLORS[
											displayStatus(a.status)
										] ?? 'var(--text-muted)'}"
										title="{STATUS_LABELS[displayStatus(a.status)] ??
											displayStatus(a.status)}{a.collSetCode
											? ' · ' + a.collSetCode.toUpperCase() + ' #' + a.collCollectorNumber
											: ''}"
									></span>
								{/each}
							</div>
							<!-- Card name -->
							<CardImage
								imageUri={card.assignments[0]?.imageUri ?? card.fallbackImageUri ?? null}
								name={card.cardName}
							>
								<a
									href="/cards/{encodeURIComponent(card.cardName)}"
									class="card-link"
									style="font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
									>{card.cardName}</a
								>
							</CardImage>
							<span style="flex:1"></span>
							<!-- Copy info: first assigned printing, or proxy/alt label -->
							{#if firstCopy}
								<span class="mono" style="font-size:10px;color:var(--text-muted);flex-shrink:0">
									{firstCopy.collSetCode!.toUpperCase()}{#if firstCopy.collFoil}<span
											class="text-muted"
											style="font-size:10px"
										>
											F</span
										>{/if}
								</span>
							{:else if card.assignments.some((a) => a.status === 'proxied')}
								<span style="font-size:10px;color:var(--text-muted);flex-shrink:0">proxy</span>
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
	{/each}
{/if}

<!-- Note Edit Modal -->
{#if noteModal !== null}
	<div
		style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;display:flex;align-items:center;justify-content:center"
		onclick={(e) => {
			if (e.target === e.currentTarget) noteModal = null;
		}}
		onkeydown={(e) => e.key === 'Escape' && (noteModal = null)}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div class="card" style="min-width:380px;max-width:520px;width:90vw;z-index:101">
			<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
				<strong>Note — {noteModal.cardName}</strong>
				<button class="btn btn-sm" onclick={() => (noteModal = null)}>✕</button>
			</div>
			<textarea
				rows="4"
				placeholder="Add a note about this card in the deck…"
				style="width:100%;resize:vertical"
				bind:value={noteModal.notes}
				onkeydown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNote();
				}}
			></textarea>
			<div class="form-hint" style="margin-bottom:10px">⌘/Ctrl+Enter to save</div>
			<div class="flex gap-2">
				<button class="btn btn-primary" onclick={saveNote} disabled={noteSaving}>
					{noteSaving ? 'Saving…' : 'Save'}
				</button>
				{#if noteModal.notes}
					<button
						class="btn btn-danger"
						onclick={() => {
							noteModal!.notes = '';
							saveNote();
						}}
						disabled={noteSaving}
					>
						Clear note
					</button>
				{/if}
				<button class="btn" onclick={() => (noteModal = null)}>Cancel</button>
			</div>
		</div>
	</div>
{/if}

<!-- Click-outside overlay to close copy dropdowns -->
{#if copyDropdownId !== null}
	<div
		style="position:fixed;inset:0;z-index:40"
		onclick={() => (copyDropdownId = null)}
		onkeydown={(e) => e.key === 'Escape' && (copyDropdownId = null)}
		role="presentation"
		aria-hidden="true"
	></div>
{/if}

<style>
	.sync-progress {
		margin: 10px 0 12px;
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
		border-radius: 6px;
		background: color-mix(in srgb, var(--accent) 8%, var(--surface));
		color: var(--text);
	}

	.sync-progress-top {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin-bottom: 8px;
		font-size: 13px;
	}

	.sync-progress-top span {
		color: var(--text-muted);
		font-size: 12px;
	}

	.sync-progress-track {
		position: relative;
		overflow: hidden;
		height: 4px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 18%, var(--surface-2));
	}

	.sync-progress-bar {
		position: absolute;
		inset: 0 auto 0 0;
		width: 38%;
		border-radius: inherit;
		background: var(--accent);
		animation: sync-slide 1.05s ease-in-out infinite;
	}

	.sync-progress-steps {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		margin-top: 8px;
		color: var(--text-muted);
		font-size: 11px;
	}

	.sync-progress-steps span {
		white-space: nowrap;
	}

	@keyframes sync-slide {
		0% {
			transform: translateX(-110%);
		}
		50% {
			transform: translateX(85%);
		}
		100% {
			transform: translateX(280%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.sync-progress-bar {
			animation: none;
			width: 100%;
		}
	}
</style>
