<script lang="ts">
	import { onMount, setContext } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { invalidateAll } from '$app/navigation';
	import ManagerGroup from './ManagerGroup.svelte';
	import type { ManagerSection, ManagerCtx, CopyOption, ManagerPreviewCard } from './manager-types';
	import {
		getIgnoreBasics,
		getManagerGroupMode,
		setManagerGroupMode,
		type ManagerGroupMode
	} from '$lib/app-settings';
	import { isBasicLand } from '$lib/basics';

	// ── Props ─────────────────────────────────────────────────────────────
	let {
		boardViewGroups,
		patchAssignment,
		patchPrintStatus,
		applyPatch,
		filterSearch = $bindable(''),
		hiddenStatuses = $bindable(new Set<string>()),
		openNoteModal,
		canEditDeck,
		mutateDeckCard
	}: {
		boardViewGroups: ManagerSection[];
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
		applyPatch: (
			id: number,
			patch: {
				status?: string;
				pulled?: boolean;
				note?: string | null;
				printStatus?: string | null;
				proxyInventoryId?: number | null;
			}
		) => void;
		filterSearch: string;
		hiddenStatuses: Set<string>;
		openNoteModal: (deckCardId: number, cardName: string, notes: string) => void;
		canEditDeck: boolean;
		mutateDeckCard: (
			deckCardId: number,
			patch: {
				quantity?: number;
				board?: 'main' | 'side' | 'maybe' | 'commander';
			}
		) => Promise<boolean>;
	} = $props();

	// ── App settings ─────────────────────────────────────────────────────
	let ignoreBasicsVal = $state(false);
	$effect(() => {
		ignoreBasicsVal = getIgnoreBasics();
	});

	// ── Copy-dropdown state (Manager-view-local) ──────────────────────────
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
			// ignore fetch errors — dropdown will show "Not in collection"
		}
		copyDropdownLoading = false;
	}

	// ── Inline proxy-note state ───────────────────────────────────────────
	let inlineNoteId = $state<number | null>(null);
	let inlineNoteText = $state('');

	async function saveInlineNote(assignmentId: number) {
		applyPatch(assignmentId, { note: inlineNoteText });
		inlineNoteId = null;
		await fetch(`/api/assignments/${assignmentId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ note: inlineNoteText })
		});
	}

	// ── Bulk selection ────────────────────────────────────────────────────
	const selectedIds = new SvelteSet<number>();

	function toggleSelect(id: number) {
		selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id);
	}

	function setSelected(ids: number[], selected: boolean) {
		for (const id of ids) {
			selected ? selectedIds.add(id) : selectedIds.delete(id);
		}
	}

	function clearSelection() {
		selectedIds.clear();
	}

	let bulkFeedback = $state('');

	function selectedProxyIds(): number[] {
		const ids: number[] = [];
		for (const section of boardViewGroups) {
			for (const group of section.groups) {
				for (const { card } of group.items) {
					for (const assignment of card.assignments) {
						if (selectedIds.has(assignment.id) && assignment.status === 'proxied') {
							ids.push(assignment.id);
						}
					}
				}
			}
		}
		return ids;
	}

	async function bulkMarkProxyPrinted(pull = false) {
		const ids = selectedProxyIds();
		if (ids.length === 0) {
			bulkFeedback = 'No proxies selected';
			setTimeout(() => (bulkFeedback = ''), 2000);
			return;
		}
		bulkFeedback = pull ? 'Printing + pulling...' : 'Marking printed...';
		for (const id of ids) {
			applyPatch(id, {
				printStatus: null,
				proxyInventoryId: -1,
				...(pull ? { pulled: true } : {})
			});
		}
		let failed = 0;
		for (const id of ids) {
			try {
				const printed = await fetch('/api/proxy-inventory', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ assignmentId: id })
				});
				if (!printed.ok) throw new Error('print failed');
				const created = await printed.json().catch(() => null);
				if (typeof created?.id === 'number') {
					applyPatch(id, { printStatus: null, proxyInventoryId: created.id });
				}
				if (pull) {
					const pulled = await fetch(`/api/assignments/${id}`, {
						method: 'PATCH',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ pulled: true })
					});
					if (!pulled.ok) throw new Error('pull failed');
				}
			} catch {
				failed++;
			}
		}
		bulkFeedback =
			failed === 0 ? `Done (${ids.length})` : `Done ${ids.length - failed}, failed ${failed}`;
		await invalidateAll();
		setTimeout(() => (bulkFeedback = ''), 2500);
	}

	async function bulkAction(action: string) {
		const ids = [...selectedIds];
		if (ids.length === 0) return;
		// Optimistic local patch for actions that have a clear local meaning
		if (action === 'unpull') ids.forEach((id) => applyPatch(id, { pulled: false }));
		if (action === 'unassign')
			ids.forEach((id) => applyPatch(id, { status: 'unassigned', pulled: false }));
		if (action === 'needed')
			ids.forEach((id) => applyPatch(id, { status: 'needed', pulled: false }));
		if (action === 'proxied')
			ids.forEach((id) => applyPatch(id, { status: 'proxied', pulled: false }));
		if (action === 'proxiedNeedsPrint')
			ids.forEach((id) =>
				applyPatch(id, { status: 'proxied', pulled: false, printStatus: 'need_print' })
			);
		if (action === 'pull') ids.forEach((id) => applyPatch(id, { pulled: true }));
		try {
			const res = await fetch('/api/assignments/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids, action })
			});
			bulkFeedback = res.ok ? `Done (${ids.length})` : 'Failed';
		} catch {
			bulkFeedback = 'Failed';
		}
		setTimeout(() => (bulkFeedback = ''), 2000);
	}

	// ── Sticky card preview ───────────────────────────────────────────────
	let previewCard = $state<ManagerPreviewCard | null>(null);

	// ── Shared context for child rows ─────────────────────────────────────
	// Getter properties close over the $state variables above so that child
	// components reading them inside reactive contexts are tracked correctly.
	const ctx: ManagerCtx = {
		patchAssignment: (...args) => patchAssignment(...args),
		patchPrintStatus: (...args) => patchPrintStatus(...args),
		applyLocalPatch: (...args) => applyPatch(...args),
		openNoteModal: (...args) => openNoteModal(...args),
		get canEditDeck() {
			return canEditDeck;
		},
		mutateDeckCard: (...args) => mutateDeckCard(...args),

		get copyDropdownId() {
			return copyDropdownId;
		},
		get copyDropdownCache() {
			return copyDropdownCache;
		},
		get copyDropdownLoading() {
			return copyDropdownLoading;
		},
		openCopyDropdown,
		closeCopyDropdown: () => {
			copyDropdownId = null;
		},

		get inlineNoteId() {
			return inlineNoteId;
		},
		get inlineNoteText() {
			return inlineNoteText;
		},
		setInlineNote: (id, text) => {
			inlineNoteId = id;
			inlineNoteText = text;
		},
		cancelInlineNote: () => {
			inlineNoteId = null;
		},
		saveInlineNote,

		setPreviewCard: (card) => {
			previewCard = card;
		},

		get ignoreBasics() {
			return ignoreBasicsVal;
		},

		get selectedIds() {
			return selectedIds;
		},
		toggleSelect,
		setSelected,
		clearSelection
	};
	setContext<ManagerCtx>('manager', ctx);

	// ── Sort + Filter state ──────────────────────────────────────────────
	type SortMode = 'none' | 'alpha' | 'cmc_asc' | 'cmc_desc';
	let sortMode = $state<SortMode>('none');
	let groupMode = $state<ManagerGroupMode>('type');
	let hidePulled = $state(false);
	let filterColors = $state(new Set<string>()); // W U B R G C M
	let filterCmc = $state(new Set<string>()); // '0','1','2','3','4','5','6+'
	let filterStatuses = $state(new Set<string>()); // fulfillment statuses
	let filterPrintStatuses = $state(new Set<string>()); // 'need_print'|'need_reprint'
	let syncChangesOnly = $state(false);

	onMount(() => {
		groupMode = getManagerGroupMode();
	});

	function changeGroupMode(event: Event) {
		groupMode = (event.currentTarget as HTMLSelectElement).value as ManagerGroupMode;
		setManagerGroupMode(groupMode);
	}

	const STATUS_CHIPS = [
		{ key: 'unassigned', label: 'Unassigned' },
		{ key: 'needed', label: 'Needed' },
		{ key: 'ordered', label: 'Ordered' },
		{ key: 'assigned', label: 'Assigned' },
		{ key: 'proxied', label: 'Proxy' }
	] as const;
	const PRINT_STATUS_CHIPS = [
		{ key: 'need_print', label: 'Needs print' },
		{ key: 'need_reprint', label: 'Reprint' }
	] as const;

	const COLOR_PIPS = ['W', 'U', 'B', 'R', 'G', 'C', 'M'] as const;
	const CMC_CHIPS = ['0', '1', '2', '3', '4', '5', '6+'] as const;
	const COLOR_DOT: Record<string, string> = {
		W: '#c8b89a',
		U: '#79b8ff',
		B: '#b57abf',
		R: '#f87171',
		G: '#4ade80',
		C: '#8b9ba8',
		M: '#e3b341'
	};
	const COLOR_LABEL: Record<string, string> = {
		W: 'W',
		U: 'U',
		B: 'B',
		R: 'R',
		G: 'G',
		C: 'C',
		M: 'Multi'
	};

	function getCardColors(manaCost: string | null): string[] {
		if (!manaCost) return ['C'];
		const pips = new Set<string>();
		for (const m of manaCost.matchAll(/\{([^}]+)\}/g)) {
			const s = m[1];
			if (s.includes('W')) pips.add('W');
			if (s.includes('U')) pips.add('U');
			if (s.includes('B')) pips.add('B');
			if (s.includes('R')) pips.add('R');
			if (s.includes('G')) pips.add('G');
		}
		if (pips.size === 0) return ['C'];
		const result = [...pips];
		if (pips.size >= 2) result.push('M');
		return result;
	}

	function cmcChipMatches(cmc: number | null, chip: string): boolean {
		const c = cmc ?? 0;
		if (chip === '6+') return c >= 6;
		return c === parseInt(chip);
	}

	function effectivePrintStatus(a: {
		status: string;
		pulled: boolean;
		printStatus: string | null;
		proxyInventoryId: number | null;
	}) {
		if (a.status !== 'proxied' || a.pulled) return null;
		if (a.printStatus === 'need_reprint') return 'need_reprint';
		if (a.printStatus === 'need_print' && a.proxyInventoryId === null) return 'need_print';
		return null;
	}

	function applyFiltersAndSort(
		items: (typeof boardViewGroups)[0]['groups'][0]['items']
	): typeof items {
		let out = items;

		if (hidePulled) {
			out = out.filter(
				(item) =>
					!item.card.assignments.every((a) => a.pulled) ||
					item.card.assignments.some((a) => effectivePrintStatus(a) === 'need_reprint')
			);
		}

		if (syncChangesOnly) {
			out = out.filter(
				(item) => (item.card.syncAddedQuantity ?? 0) > 0 || (item.card.syncReturnCount ?? 0) > 0
			);
		}

		if (filterStatuses.size > 0) {
			out = out.filter((item) => item.card.assignments.some((a) => filterStatuses.has(a.status)));
		}

		if (filterPrintStatuses.size > 0) {
			out = out.filter((item) =>
				item.card.assignments.some((a) => filterPrintStatuses.has(effectivePrintStatus(a) ?? ''))
			);
		}

		if (filterColors.size > 0) {
			out = out.filter((item) => {
				const mc = item.card.assignments[0]?.manaCost ?? null;
				const colors = getCardColors(mc);
				return colors.some((c) => filterColors.has(c));
			});
		}

		if (filterCmc.size > 0) {
			out = out.filter((item) => {
				const cmc = item.card.assignments[0]?.cmc ?? 0;
				return [...filterCmc].some((chip) => cmcChipMatches(cmc, chip));
			});
		}

		if (sortMode === 'alpha') {
			return [...out].sort((a, b) => a.card.cardName.localeCompare(b.card.cardName));
		}
		if (sortMode === 'cmc_asc') {
			return [...out].sort(
				(a, b) =>
					(a.card.assignments[0]?.cmc ?? 0) - (b.card.assignments[0]?.cmc ?? 0) ||
					a.card.cardName.localeCompare(b.card.cardName)
			);
		}
		if (sortMode === 'cmc_desc') {
			return [...out].sort(
				(a, b) =>
					(b.card.assignments[0]?.cmc ?? 0) - (a.card.assignments[0]?.cmc ?? 0) ||
					a.card.cardName.localeCompare(b.card.cardName)
			);
		}
		return out;
	}

	const COLOR_GROUPS = [
		{ key: 'W', label: 'White' },
		{ key: 'U', label: 'Blue' },
		{ key: 'B', label: 'Black' },
		{ key: 'R', label: 'Red' },
		{ key: 'G', label: 'Green' },
		{ key: 'M', label: 'Multicolor' },
		{ key: 'C', label: 'Colorless' }
	] as const;

	function getColorGroup(manaCost: string | null): string {
		const colors = getCardColors(manaCost).filter((color) => color !== 'M' && color !== 'C');
		if (colors.length === 0) return 'C';
		return colors.length > 1 ? 'M' : colors[0];
	}

	function buildManagerGroup(
		label: string,
		key: string | number,
		items: (typeof boardViewGroups)[0]['groups'][0]['items']
	) {
		return {
			label,
			key,
			items,
			total: items.reduce((count, { card }) => count + card.quantity, 0),
			done: items.reduce(
				(count, { card }) =>
					count +
					card.assignments.filter(
						(assignment) =>
							assignment.pulled ||
							assignment.status === 'proxied' ||
							(assignment.status === 'assigned' && assignment.collectionId !== null)
					).length,
				0
			)
		};
	}

	const syncAddedCount = $derived.by(() =>
		boardViewGroups.reduce(
			(sectionTotal, section) =>
				sectionTotal +
				section.groups.reduce(
					(groupTotal, group) =>
						groupTotal +
						group.items.reduce(
							(itemTotal, { card }) => itemTotal + (card.syncAddedQuantity ?? 0),
							0
						),
					0
				),
			0
		)
	);
	const syncReturnCount = $derived.by(() =>
		boardViewGroups.reduce(
			(sectionTotal, section) =>
				sectionTotal +
				section.groups.reduce(
					(groupTotal, group) =>
						groupTotal +
						group.items.reduce((itemTotal, { card }) => itemTotal + (card.syncReturnCount ?? 0), 0),
					0
				),
			0
		)
	);
	const hasSyncChanges = $derived(syncAddedCount > 0 || syncReturnCount > 0);
	const anyFilter = $derived(
		hidePulled ||
			syncChangesOnly ||
			filterColors.size > 0 ||
			filterCmc.size > 0 ||
			filterStatuses.size > 0 ||
			filterPrintStatuses.size > 0 ||
			sortMode !== 'none'
	);
	const hasActiveFilters = $derived(
		filterColors.size > 0 ||
			filterCmc.size > 0 ||
			filterStatuses.size > 0 ||
			filterPrintStatuses.size > 0
	);

	// Collapsed Filters panel — auto-open when filters are active
	let filtersOpen = $state(false);
	$effect(() => {
		if (hasActiveFilters) filtersOpen = true;
	});

	type ExportKind = 'proxies' | 'unowned' | 'combined';

	function addExportLine(lines: Map<string, number>, name: string, count = 1) {
		lines.set(name, (lines.get(name) ?? 0) + count);
	}

	function buildExportLines(kind: ExportKind): string[] {
		const lines = new Map<string, number>();
		for (const section of boardViewGroups) {
			for (const group of section.groups) {
				for (const { card } of group.items) {
					if (isBasicLand(card.cardName)) continue;
					for (const a of card.assignments) {
						const isNotPrintedProxy = effectivePrintStatus(a) !== null;
						const isUnowned = a.status === 'needed' && (card.collQty ?? 0) === 0;

						if ((kind === 'proxies' || kind === 'combined') && isNotPrintedProxy) {
							addExportLine(lines, card.cardName);
						}
						if ((kind === 'unowned' || kind === 'combined') && isUnowned) {
							addExportLine(lines, card.cardName);
						}
					}
				}
			}
		}
		return [...lines.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, count]) => `${count} ${name}`);
	}

	const proxyExportLines = $derived(buildExportLines('proxies'));
	const unownedExportLines = $derived(buildExportLines('unowned'));
	const combinedExportLines = $derived(buildExportLines('combined'));
	const needsProxyPrintIds = $derived.by(() => {
		const ids: number[] = [];
		for (const section of boardViewGroups) {
			for (const group of section.groups) {
				for (const { card } of group.items) {
					if (isBasicLand(card.cardName)) continue;
					const noOwnedCopies = (card.collQty ?? 0) === 0;
					const allCopiesUsedElsewhere = (card.collQty ?? 0) > 0 && (card.availableQty ?? 0) === 0;
					if (!noOwnedCopies && !allCopiesUsedElsewhere) continue;
					for (const a of card.assignments) {
						if (a.status === 'needed') ids.push(a.id);
					}
				}
			}
		}
		return ids;
	});

	let copyPrintFeedback = $state('');
	let workflowFeedback = $state('');

	async function copyText(text: string): Promise<boolean> {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			const textarea = document.createElement('textarea');
			textarea.value = text;
			textarea.setAttribute('readonly', '');
			textarea.style.position = 'fixed';
			textarea.style.left = '-9999px';
			document.body.appendChild(textarea);
			textarea.select();
			try {
				return document.execCommand('copy');
			} finally {
				document.body.removeChild(textarea);
			}
		}
	}

	async function copyExport(kind: ExportKind) {
		const lines =
			kind === 'proxies'
				? proxyExportLines
				: kind === 'unowned'
					? unownedExportLines
					: combinedExportLines;
		if (await copyText(lines.join('\n'))) {
			copyPrintFeedback = `Copied ${lines.length}`;
		} else {
			copyPrintFeedback = 'Failed';
		}
		setTimeout(() => (copyPrintFeedback = ''), 2000);
	}

	async function proxyUnavailableCards() {
		if (needsProxyPrintIds.length === 0) return;
		const ids = needsProxyPrintIds;
		workflowFeedback = 'Marking...';
		for (const id of ids) {
			applyPatch(id, { status: 'proxied', pulled: false, printStatus: 'need_print' });
		}
		try {
			const res = await fetch('/api/assignments/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids, action: 'proxiedNeedsPrint' })
			});
			workflowFeedback = res.ok ? `Proxied ${ids.length}` : 'Failed';
		} catch {
			workflowFeedback = 'Failed';
		}
		setTimeout(() => (workflowFeedback = ''), 2000);
	}

	const sortedBoardViewGroups = $derived.by(() =>
		boardViewGroups
			.map((section) => {
				if (groupMode === 'type') {
					return {
						...section,
						groups: section.groups
							.map((group) => ({
								...group,
								items: applyFiltersAndSort(group.items)
							}))
							.filter((group) => group.items.length > 0)
					};
				}

				const sectionItems = applyFiltersAndSort(section.groups.flatMap((group) => group.items));
				if (groupMode === 'deck') {
					return {
						...section,
						groups:
							sectionItems.length > 0
								? [
										buildManagerGroup(
											section.label || 'Deck',
											`deck-${section.label || 'main'}`,
											sectionItems
										)
									]
								: []
					};
				}

				return {
					...section,
					groups: COLOR_GROUPS.map(({ key, label }) => {
						const items = sectionItems.filter(({ card }) => getColorGroup(card.manaCost) === key);
						return buildManagerGroup(label, `color-${section.label || 'main'}-${key}`, items);
					}).filter((group) => group.items.length > 0)
				};
			})
			.filter((section) => section.groups.length > 0)
	);

	const allVisibleIds = $derived.by(() => {
		const ids: number[] = [];
		for (const section of sortedBoardViewGroups) {
			for (const group of section.groups) {
				for (const { card } of group.items) {
					for (const a of card.assignments) ids.push(a.id);
				}
			}
		}
		return ids;
	});

	function selectAllVisible() {
		selectedIds.clear();
		for (const id of allVisibleIds) selectedIds.add(id);
	}

	const firstPreviewCard = $derived.by(() => {
		for (const section of sortedBoardViewGroups) {
			for (const group of section.groups) {
				for (const { card } of group.items) {
					const assignment = card.assignments[0];
					if (!assignment) continue;
					const printing = assignment.collSetCode
						? `${assignment.collSetCode.toUpperCase()} #${assignment.collCollectorNumber}${assignment.collFoil ? ' F' : ''}`
						: assignment.proxySetCode
							? `${assignment.proxySetCode.toUpperCase()} #${assignment.proxyCollectorNumber}`
							: null;
					return {
						name: card.cardName,
						imageUri: assignment.imageUri ?? card.fallbackImageUri ?? null,
						printing
					};
				}
			}
		}
		return null;
	});
	const visiblePreviewNames = $derived.by(() => {
		const names = new Set<string>();
		for (const section of sortedBoardViewGroups) {
			for (const group of section.groups) {
				for (const { card } of group.items) names.add(card.cardName);
			}
		}
		return names;
	});
	$effect(() => {
		if (!firstPreviewCard) {
			previewCard = null;
		} else if (!previewCard || !visiblePreviewNames.has(previewCard.name)) {
			previewCard = firstPreviewCard;
		}
	});
</script>

{#if hasSyncChanges}
	<div class="mgr-sync-summary" role="status">
		<strong>Sync changes</strong>
		{#if syncAddedCount > 0}
			<span class="mgr-sync-count mgr-sync-count--added">{syncAddedCount} added</span>
		{/if}
		{#if syncReturnCount > 0}
			<span class="mgr-sync-count mgr-sync-count--return">{syncReturnCount} to take out</span>
		{/if}
		<button
			class="btn btn-sm"
			class:mgr-sync-filter-active={syncChangesOnly}
			onclick={() => (syncChangesOnly = !syncChangesOnly)}
			>{syncChangesOnly ? 'Show all cards' : 'Show changes only'}</button
		>
		{#if syncAddedCount > 0}
			<form method="POST" action="?/acknowledgeSyncAdditions">
				<button class="btn btn-sm" type="submit">Mark additions reviewed</button>
			</form>
		{/if}
	</div>
{/if}

<!-- Manager toolbar -->
<div class="mgr-toolbar">
	<input type="search" placeholder="Search cards…" bind:value={filterSearch} class="mgr-search" />
	<label class="mgr-group-control">
		<span>Group</span>
		<select value={groupMode} onchange={changeGroupMode} aria-label="Group cards">
			<option value="deck">Deck</option>
			<option value="type">Type</option>
			<option value="color">Color</option>
		</select>
	</label>
	<button
		class="btn btn-sm"
		style={sortMode !== 'none'
			? 'color:var(--accent);border-color:color-mix(in srgb,var(--accent) 50%,transparent);background:color-mix(in srgb,var(--accent) 8%,transparent)'
			: ''}
		onclick={() => {
			if (sortMode === 'none') sortMode = 'alpha';
			else if (sortMode === 'alpha') sortMode = 'cmc_asc';
			else if (sortMode === 'cmc_asc') sortMode = 'cmc_desc';
			else sortMode = 'none';
		}}
		title="Sort: Default → Name A–Z → CMC ↑ → CMC ↓"
		>Sort{sortMode !== 'none'
			? ': ' + (sortMode === 'alpha' ? 'A–Z' : sortMode === 'cmc_asc' ? 'CMC ↑' : 'CMC ↓')
			: ''}</button
	>
	<button
		class="btn btn-sm"
		style={hidePulled
			? 'color:var(--success);border-color:color-mix(in srgb,var(--success) 50%,transparent);background:color-mix(in srgb,var(--success) 8%,transparent)'
			: ''}
		onclick={() => (hidePulled = !hidePulled)}
		title={hidePulled ? 'Show pulled cards' : 'Hide pulled cards'}>Hide Pulled</button
	>
	<button
		class="btn btn-sm"
		style={filtersOpen || hasActiveFilters
			? 'color:var(--accent);border-color:color-mix(in srgb,var(--accent) 50%,transparent);background:color-mix(in srgb,var(--accent) 8%,transparent)'
			: ''}
		onclick={() => (filtersOpen = !filtersOpen)}
		title="Toggle color and CMC filters">Filters{hasActiveFilters ? ' •' : ' ▾'}</button
	>
	{#if proxyExportLines.length > 0}
		<button
			class="btn btn-sm"
			style="color:var(--warning);border-color:color-mix(in srgb,var(--warning) 45%,transparent)"
			onclick={() => copyExport('proxies')}
			title="Copy not-printed proxy cards for Proxxied import"
			>{copyPrintFeedback || `Copy ${proxyExportLines.length} to print`}</button
		>
	{/if}
	{#if unownedExportLines.length > 0}
		<button
			class="btn btn-sm"
			style="color:var(--danger);border-color:color-mix(in srgb,var(--danger) 38%,transparent)"
			onclick={() => copyExport('unowned')}
			title="Copy unowned non-basic cards for Proxxied import"
			>{copyPrintFeedback || `Copy ${unownedExportLines.length} unowned`}</button
		>
	{/if}
	{#if combinedExportLines.length > 0}
		<button
			class="btn btn-sm"
			onclick={() => copyExport('combined')}
			title="Copy not-printed proxies and unowned non-basic cards"
			>{copyPrintFeedback || `Copy ${combinedExportLines.length} print list`}</button
		>
	{/if}
	{#if needsProxyPrintIds.length > 0}
		<button
			class="btn btn-sm"
			style="color:var(--proxy);border-color:color-mix(in srgb,var(--proxy) 45%,transparent)"
			onclick={proxyUnavailableCards}
			title="Mark unowned or unavailable non-basic needed slots as proxies needing print"
			>{workflowFeedback || `Proxy ${needsProxyPrintIds.length} unavailable`}</button
		>
	{/if}
	{#if filterSearch || anyFilter}
		<button
			class="btn btn-sm"
			onclick={() => {
				filterSearch = '';
				hiddenStatuses = new Set();
				sortMode = 'none';
				hidePulled = false;
				syncChangesOnly = false;
				filterColors = new Set();
				filterCmc = new Set();
				filterStatuses = new Set();
				filterPrintStatuses = new Set();
				filtersOpen = false;
			}}>Clear</button
		>
	{/if}
</div>

{#if filtersOpen}
	<div class="mgr-filter-row">
		<span class="mgr-filter-label">Status</span>
		{#each STATUS_CHIPS as s}
			<button
				class="mgr-status-chip"
				class:mgr-status-chip--active={filterStatuses.has(s.key)}
				onclick={() => {
					const f = new Set(filterStatuses);
					f.has(s.key) ? f.delete(s.key) : f.add(s.key);
					filterStatuses = f;
				}}>{s.label}</button
			>
		{/each}
		<span class="mgr-filter-divider"></span>
		<span class="mgr-filter-label">Print</span>
		{#each PRINT_STATUS_CHIPS as s}
			<button
				class="mgr-status-chip"
				class:mgr-status-chip--active={filterPrintStatuses.has(s.key)}
				onclick={() => {
					const f = new Set(filterPrintStatuses);
					f.has(s.key) ? f.delete(s.key) : f.add(s.key);
					filterPrintStatuses = f;
				}}>{s.label}</button
			>
		{/each}
		<span class="mgr-filter-divider"></span>
		<span class="mgr-filter-label">Color</span>
		{#each COLOR_PIPS as c}
			<button
				class="mgr-color-chip"
				class:mgr-color-chip--active={filterColors.has(c)}
				style="--dot:{COLOR_DOT[c]}"
				onclick={() => {
					const s = new Set(filterColors);
					s.has(c) ? s.delete(c) : s.add(c);
					filterColors = s;
				}}
				title={c === 'C' ? 'Colorless' : c === 'M' ? 'Multicolor' : c}
				><span class="mgr-color-dot"></span>{COLOR_LABEL[c]}</button
			>
		{/each}
		<span class="mgr-filter-divider"></span>
		<span class="mgr-filter-label">CMC</span>
		{#each CMC_CHIPS as chip}
			<button
				class="mgr-cmc-chip"
				class:mgr-cmc-chip--active={filterCmc.has(chip)}
				onclick={() => {
					const s = new Set(filterCmc);
					s.has(chip) ? s.delete(chip) : s.add(chip);
					filterCmc = s;
				}}>{chip}</button
			>
		{/each}
	</div>
{/if}

<div class="mgr-bulk-bar mgr-bulk-bar--idle">
	<button class="mgr-bulk-hint" onclick={selectAllVisible} title="Select all visible cards"
		>Select all</button
	>
</div>

{#if selectedIds.size > 0}
	<div class="mgr-bulk-tray">
		<span class="mgr-bulk-count">{selectedIds.size} selected</span>
		<button class="mgr-bulk-btn mgr-bulk-btn--pull" onclick={() => bulkAction('pull')}>Pull</button>
		<button class="mgr-bulk-btn mgr-bulk-btn--unpull" onclick={() => bulkAction('unpull')}
			>Unpull</button
		>
		<button class="mgr-bulk-btn mgr-bulk-btn--proxy" onclick={() => bulkAction('proxied')}
			>Proxy</button
		>
		<button class="mgr-bulk-btn mgr-bulk-btn--print" onclick={() => bulkAction('proxiedNeedsPrint')}
			>Proxy + Print</button
		>
		<button class="mgr-bulk-btn mgr-bulk-btn--printed" onclick={() => bulkMarkProxyPrinted(false)}
			>Printed</button
		>
		<button
			class="mgr-bulk-btn mgr-bulk-btn--printed-pull"
			onclick={() => bulkMarkProxyPrinted(true)}>Printed + Pull</button
		>
		<button class="mgr-bulk-btn mgr-bulk-btn--needed" onclick={() => bulkAction('needed')}
			>Needed</button
		>
		<button class="mgr-bulk-btn mgr-bulk-btn--unassign" onclick={() => bulkAction('unassign')}
			>Unassign</button
		>
		<span class="mgr-bulk-spacer"></span>
		{#if bulkFeedback}<span class="mgr-bulk-feedback">{bulkFeedback}</span>{/if}
		<button
			class="mgr-bulk-btn mgr-bulk-btn--all"
			onclick={selectAllVisible}
			title="Select all visible">All</button
		>
		<button
			class="mgr-bulk-btn mgr-bulk-btn--clear"
			onclick={clearSelection}
			title="Clear selection">✕ Clear</button
		>
	</div>
{/if}

<div class="mgr-manager-shell">
	<aside class="mgr-preview-rail" aria-label="Card preview">
		{#if previewCard?.imageUri}
			<img class="mgr-preview-img" src={previewCard.imageUri} alt={previewCard.name} />
		{:else}
			<div class="mgr-preview-empty"></div>
		{/if}
		{#if previewCard}
			<div class="mgr-preview-meta">
				<div class="mgr-preview-name">{previewCard.name}</div>
				{#if previewCard.printing}
					<div class="mgr-preview-printing">{previewCard.printing}</div>
				{/if}
			</div>
		{/if}
	</aside>

	<div class="mgr-board-list">
		<!-- Board sections with type groups in a responsive column layout -->
		{#each sortedBoardViewGroups as section}
			{#if section.label}
				<div class="mgr-section-divider">
					<hr class="mgr-section-rule" />
					<span class="mgr-section-label">{section.label}</span>
					<hr class="mgr-section-rule" />
				</div>
			{/if}

			<div class="mgr-groups-layout">
				{#each section.groups as group}
					<ManagerGroup {group} />
				{/each}
			</div>
		{/each}
	</div>
</div>

<!-- Click-outside overlay closes copy dropdown -->
{#if copyDropdownId !== null}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="mgr-overlay"
		onclick={() => {
			copyDropdownId = null;
		}}
		onkeydown={(e) => e.key === 'Escape' && (copyDropdownId = null)}
		role="presentation"
		aria-hidden="true"
	></div>
{/if}

<style>
	/* ── Toolbar ────────────────────────────────────────────────────────── */
	.mgr-toolbar {
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 6px;
		padding: 0 2px;
	}

	/* ── Filter row (color + CMC) ────────────────────────────────────────── */
	.mgr-filter-row {
		display: flex;
		gap: 4px;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 10px;
		padding: 0 2px;
	}
	.mgr-filter-label {
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
		flex-shrink: 0;
		margin-right: 2px;
	}
	.mgr-filter-divider {
		width: 1px;
		height: 14px;
		background: var(--border);
		flex-shrink: 0;
		margin: 0 4px;
	}
	.mgr-status-chip {
		display: inline-flex;
		align-items: center;
		padding: 2px 7px;
		font-size: 11px;
		font-weight: 600;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition: all 0.1s;
	}
	.mgr-status-chip:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}
	.mgr-status-chip--active {
		border-color: color-mix(in srgb, var(--accent) 60%, transparent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		color: var(--accent);
	}

	.mgr-color-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 7px;
		font-size: 11px;
		font-weight: 600;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition: all 0.1s;
	}
	.mgr-color-chip:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}
	.mgr-color-chip--active {
		border-color: var(--dot);
		background: color-mix(in srgb, var(--dot) 12%, transparent);
		color: var(--text);
	}
	.mgr-color-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--dot);
		flex-shrink: 0;
	}
	/* CSS custom property for dot color (set via style="--dot:...") */
	.mgr-color-chip {
		--dot: var(--text-muted);
	}

	.mgr-cmc-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 26px;
		height: 22px;
		padding: 0 5px;
		font-size: 11px;
		font-weight: 600;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		font-family: 'SF Mono', 'Fira Code', monospace;
	}
	.mgr-cmc-chip:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}
	.mgr-cmc-chip--active {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		border-color: color-mix(in srgb, var(--accent) 50%, transparent);
		color: var(--accent);
	}
	.mgr-search {
		padding: 5px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		font-size: 13px;
		min-width: 180px;
	}
	.mgr-group-control {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 28px;
		padding-left: 8px;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--surface);
		color: var(--text-muted);
		font-size: 11px;
		font-weight: 600;
	}
	.mgr-group-control select {
		height: 26px;
		padding: 0 24px 0 2px;
		border: 0;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	.mgr-group-control select:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
		outline-offset: -2px;
	}

	/* ── Moxfield-style persistent preview rail ─────────────────────────── */
	:global(.app-main:has(.mgr-manager-shell)) {
		overflow-y: visible;
		overflow-x: clip;
	}
	.mgr-manager-shell {
		display: grid;
		grid-template-columns: 260px minmax(0, 1fr);
		gap: 18px;
		align-items: start;
	}
	.mgr-preview-rail {
		position: sticky;
		top: 68px;
		padding: 10px 0 0;
	}
	.mgr-preview-img {
		display: block;
		width: 240px;
		max-width: 100%;
		border-radius: 11px;
		box-shadow: 0 2px 9px rgba(0, 0, 0, 0.24);
	}
	.mgr-preview-empty {
		width: 240px;
		max-width: 100%;
		aspect-ratio: 5 / 7;
		border-radius: 11px;
		border: 1px solid var(--border);
		background: var(--surface-2);
	}
	.mgr-preview-meta {
		width: 240px;
		max-width: 100%;
		margin-top: 8px;
		text-align: center;
		color: var(--text-muted);
	}
	.mgr-preview-name {
		font-size: 12px;
		font-weight: 700;
		color: var(--text);
	}
	.mgr-preview-printing {
		margin-top: 3px;
		font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
		font-size: 11px;
	}
	.mgr-board-list {
		min-width: 0;
	}

	/* ── Board-section divider ──────────────────────────────────────────── */
	.mgr-section-divider {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 18px 0 10px;
		color: var(--text-muted);
	}
	.mgr-section-rule {
		flex: 1;
		border: none;
		border-top: 1px solid var(--border);
		margin: 0;
	}
	.mgr-section-label {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		white-space: nowrap;
	}

	/* ── Group grid — fills width with auto columns, min 380px each ─────── */
	.mgr-groups-layout {
		columns: 380px;
		column-gap: 12px;
		padding: 0 2px;
	}

	@media (max-width: 1180px) {
		.mgr-manager-shell {
			display: block;
		}
		.mgr-preview-rail {
			display: none;
		}
	}

	/* ── Click-outside overlay ──────────────────────────────────────────── */
	.mgr-overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
	}

	/* ── Bulk selection — idle hint ─────────────────────────────────────── */
	.mgr-bulk-bar--idle {
		padding: 0 2px;
		margin-bottom: 2px;
	}
	.mgr-bulk-hint {
		font-size: 11px;
		color: var(--text-muted);
		opacity: 0.4;
		background: none;
		border: none;
		cursor: pointer;
		padding: 2px 4px;
		border-radius: 3px;
	}
	.mgr-bulk-hint:hover {
		opacity: 1;
		color: var(--accent);
	}

	/* ── Bulk selection — fixed bottom tray ─────────────────────────────── */
	.mgr-bulk-tray {
		position: fixed;
		bottom: 16px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 80;
		display: flex;
		align-items: center;
		gap: 5px;
		flex-wrap: nowrap;
		padding: 8px 12px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.28);
		white-space: nowrap;
	}
	.mgr-bulk-count {
		font-size: 11px;
		font-weight: 700;
		color: var(--accent);
		padding: 0 6px 0 2px;
		border-right: 1px solid var(--border);
		margin-right: 2px;
		white-space: nowrap;
	}
	.mgr-bulk-spacer {
		width: 8px;
	}
	.mgr-bulk-feedback {
		font-size: 11px;
		color: var(--success);
		font-weight: 600;
		padding: 0 4px;
	}
	.mgr-bulk-btn {
		padding: 4px 10px;
		font-size: 11px;
		font-weight: 600;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface-2);
		color: var(--text-muted);
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.1s;
	}
	.mgr-bulk-btn:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}
	.mgr-bulk-btn--pull {
		color: var(--success);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
	}
	.mgr-bulk-btn--pull:hover {
		background: color-mix(in srgb, var(--success) 12%, var(--surface));
	}
	.mgr-bulk-btn--unpull {
		color: var(--text-muted);
	}
	.mgr-bulk-btn--proxy {
		color: var(--proxy);
		border-color: color-mix(in srgb, var(--proxy) 40%, transparent);
	}
	.mgr-bulk-btn--proxy:hover {
		background: color-mix(in srgb, var(--proxy) 10%, var(--surface));
	}
	.mgr-bulk-btn--print {
		color: var(--warning);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
	}
	.mgr-bulk-btn--print:hover {
		background: color-mix(in srgb, var(--warning) 10%, var(--surface));
	}
	.mgr-bulk-btn--printed {
		color: var(--proxy);
		border-color: color-mix(in srgb, var(--proxy) 40%, transparent);
	}
	.mgr-bulk-btn--printed:hover {
		background: color-mix(in srgb, var(--proxy) 10%, var(--surface));
	}
	.mgr-bulk-btn--printed-pull {
		color: var(--success);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
	}
	.mgr-bulk-btn--printed-pull:hover {
		background: color-mix(in srgb, var(--success) 12%, var(--surface));
	}
	.mgr-bulk-btn--needed {
		color: var(--warning);
	}
	.mgr-bulk-btn--unassign {
		color: color-mix(in srgb, var(--error) 70%, var(--text-muted));
	}
	.mgr-bulk-btn--unassign:hover {
		color: var(--error);
		background: color-mix(in srgb, var(--error) 8%, var(--surface));
	}
	.mgr-bulk-btn--clear {
		color: var(--text-muted);
	}
	.mgr-bulk-btn--clear:hover {
		color: var(--error);
	}
	.mgr-bulk-btn--all {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 35%, transparent);
	}

	.mgr-sync-summary {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 8px;
		padding: 7px 8px;
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--accent) 3%, var(--surface));
		font-size: 12px;
	}
	.mgr-sync-summary form {
		display: inline;
	}
	.mgr-sync-count {
		font-weight: 700;
		white-space: nowrap;
	}
	.mgr-sync-count--added {
		color: var(--assigned);
	}
	.mgr-sync-count--return {
		color: var(--danger);
	}
	.mgr-sync-filter-active {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 50%, transparent);
		background: color-mix(in srgb, var(--accent) 8%, var(--surface));
	}
</style>
