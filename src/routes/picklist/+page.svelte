<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { PageData } from './$types';
	import { LOCATION_LABELS, STATUS_LABELS } from '$lib/types';
	import type { CardLocation } from '$lib/types';
	import { goto, invalidateAll } from '$app/navigation';
	import CardImage from '$lib/components/CardImage.svelte';
	import {
		getBucketConfig,
		getItemBucketLabel,
		getLandSubtype,
		sortKey,
		type BucketConfig
	} from '$lib/bucket-config';
	import { isLandOnlyTypeLine } from '$lib/card-classification';

	let { data }: { data: PageData } = $props();

	// Track pulled state client-side to avoid full reload on each checkbox
	let pulledSet = $state(new Set<number>());

	let selectedDeckIds = $state<Set<number>>(untrack(() => new Set(data.selectedDeckIds)));
	$effect(() => {
		selectedDeckIds = new Set(data.selectedDeckIds);
	});

	let deckDropdownOpen = $state(false);

	function applyFilters(ids: Set<number>) {
		const params = new URLSearchParams();
		if (ids.size === 0) {
			params.set('deck', 'none');
		} else if (ids.size < data.allDecks.length) {
			params.set('deck', [...ids].join(','));
		}
		goto('/picklist?' + params.toString());
	}

	function toggleDeck(id: number) {
		const s = new Set(selectedDeckIds);
		if (s.has(id)) s.delete(id);
		else s.add(id);
		selectedDeckIds = s;
		applyFilters(s);
	}

	async function updatePulled(assignmentId: number, pulledVal: boolean) {
		if (pulledVal) pulledSet.add(assignmentId);
		else pulledSet.delete(assignmentId);
		pulledSet = new Set(pulledSet);
		const res = await fetch(`/api/assignments/${assignmentId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pulled: pulledVal })
		});
		if (!res.ok) {
			if (pulledVal) pulledSet.delete(assignmentId);
			else pulledSet.add(assignmentId);
			pulledSet = new Set(pulledSet);
		}
	}

	// ── Row action menu ───────────────────────────────────────────────────
	let openMenuId = $state<number | null>(null);
	let menuUpward = $state(false);
	let menuBusy = $state(false);
	let contextMenuPosition = $state<{ x: number; y: number } | null>(null);
	let localPatches = $state(
		new Map<
			number,
			{
				status?: string;
				pulled?: boolean;
				printStatus?: string | null;
				collectionId?: number | null;
			}
		>()
	);

	function openMenu(id: number, e: MouseEvent) {
		if (openMenuId === id) {
			openMenuId = null;
			return;
		}
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menuUpward = window.innerHeight - rect.bottom < 160;
		contextMenuPosition = null;
		openMenuId = id;
		copyPickerId = null; // close copy picker if open
	}

	function openContextMenu(id: number, e: MouseEvent) {
		e.preventDefault();
		const menuWidth = 190;
		const menuHeight = 180;
		contextMenuPosition = {
			x: Math.max(8, Math.min(e.clientX, window.innerWidth - menuWidth - 8)),
			y: Math.max(8, Math.min(e.clientY, window.innerHeight - menuHeight - 8))
		};
		menuUpward = false;
		openMenuId = id;
		copyPickerId = null;
	}

	function patchItem(
		assignmentId: number,
		patch: {
			status?: string;
			pulled?: boolean;
			printStatus?: string | null;
			collectionId?: number | null;
		}
	) {
		const next = new Map(localPatches);
		next.set(assignmentId, { ...(next.get(assignmentId) ?? {}), ...patch });
		localPatches = next;
		if (patch.pulled === true) pulledSet.add(assignmentId);
		if (patch.pulled === false) pulledSet.delete(assignmentId);
		if (patch.pulled !== undefined) pulledSet = new Set(pulledSet);
	}

	function clearLocalPatch(assignmentId: number) {
		const next = new Map(localPatches);
		next.delete(assignmentId);
		localPatches = next;
	}

	async function applyAction(assignmentId: number, body: Record<string, unknown>) {
		menuBusy = true;
		openMenuId = null;
		contextMenuPosition = null;
		const previous = localPatches.get(assignmentId);
		patchItem(assignmentId, {
			...(typeof body.status === 'string' ? { status: body.status } : {}),
			...(typeof body.pulled === 'boolean' ? { pulled: body.pulled } : {}),
			...(body.printStatus === null || typeof body.printStatus === 'string'
				? { printStatus: body.printStatus as string | null }
				: {}),
			...(body.collectionId === null || typeof body.collectionId === 'number'
				? { collectionId: body.collectionId as number | null }
				: {}),
			...(body.status === 'needed' ? { pulled: false } : {})
		});
		try {
			const response = await fetch(`/api/assignments/${assignmentId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) throw new Error('Action failed');
			await invalidateAll();
			clearLocalPatch(assignmentId);
		} catch {
			const next = new Map(localPatches);
			if (previous) next.set(assignmentId, previous);
			else next.delete(assignmentId);
			localPatches = next;
		} finally {
			menuBusy = false;
		}
	}

	async function markProxyPrinted(assignmentId: number, pull = false) {
		menuBusy = true;
		openMenuId = null;
		contextMenuPosition = null;
		const previous = localPatches.get(assignmentId);
		patchItem(assignmentId, { printStatus: null, ...(pull ? { pulled: true } : {}) });
		try {
			const printed = await fetch('/api/proxy-inventory', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ assignmentId })
			});
			if (!printed.ok) throw new Error('Could not mark proxy printed');
			if (pull) {
				const pulled = await fetch(`/api/assignments/${assignmentId}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ pulled: true })
				});
				if (!pulled.ok) throw new Error('Printed, but could not mark pulled');
			}
			await invalidateAll();
			clearLocalPatch(assignmentId);
		} catch {
			const next = new Map(localPatches);
			if (previous) next.set(assignmentId, previous);
			else next.delete(assignmentId);
			localPatches = next;
			if (pull) {
				pulledSet.delete(assignmentId);
				pulledSet = new Set(pulledSet);
			}
		} finally {
			menuBusy = false;
		}
	}

	// ── Copy picker (inline assign) ───────────────────────────────────────
	type CopyOption = {
		id: number;
		setCode: string;
		collectorNumber: string;
		foil: boolean;
		condition: string;
		quantity: number;
		available: number;
		locationOverride: string | null;
		conflicts: { deckName: string; status: string }[];
	};
	let copyPickerId = $state<number | null>(null);
	let copyPickerOptions = $state<CopyOption[]>([]);
	let copyPickerLoading = $state(false);
	let copyPickerUpward = $state(false);

	async function openCopyPicker(assignmentId: number, e: MouseEvent) {
		e.stopPropagation();
		if (copyPickerId === assignmentId) {
			copyPickerId = null;
			return;
		}
		openMenuId = null;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		copyPickerUpward = window.innerHeight - rect.bottom < 260;
		copyPickerId = assignmentId;
		copyPickerOptions = [];
		copyPickerLoading = true;
		try {
			const res = await fetch(`/api/assignments/${assignmentId}`);
			copyPickerOptions = await res.json();
		} catch {
			/* show empty */
		}
		copyPickerLoading = false;
	}

	async function pickCopy(
		assignmentId: number,
		copy: CopyOption,
		currentCollectionId: number | null
	) {
		const isCurrent = copy.id === currentCollectionId;
		if (isCurrent) {
			copyPickerId = null;
			return;
		}
		const status = 'assigned';
		copyPickerId = null;
		menuBusy = true;
		await fetch(`/api/assignments/${assignmentId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status, collectionId: copy.id })
		});
		await invalidateAll();
		menuBusy = false;
	}

	function isPulled(item: { assignmentId: number; status: string; pulled?: boolean }) {
		const localPulled = localPatches.get(item.assignmentId)?.pulled;
		return localPulled ?? (pulledSet.has(item.assignmentId) || (item.pulled ?? false));
	}

	function itemStatus(item: PickItem) {
		return localPatches.get(item.assignmentId)?.status ?? item.status;
	}

	function itemPrintStatus(item: PickItem) {
		const patch = localPatches.get(item.assignmentId);
		return patch && 'printStatus' in patch ? (patch.printStatus ?? null) : item.printStatus;
	}

	function itemCollectionId(item: PickItem) {
		const patch = localPatches.get(item.assignmentId);
		return patch && 'collectionId' in patch ? (patch.collectionId ?? null) : item.collectionId;
	}

	const TYPE_LABELS: Record<number, string> = {
		0: 'Creature / Planeswalker',
		1: 'Instant',
		2: 'Sorcery',
		3: 'Enchantment',
		4: 'Aura',
		5: 'Enchantment (Room / Battle)',
		6: 'Artifact',
		7: 'Equipment',
		8: 'Vehicle',
		9: 'Land',
		10: 'Other'
	};

	// ── Bucket config ──────────────────────────────────────────────────────────
	let bucketConfig = $state<BucketConfig | null>(null);
	onMount(() => {
		bucketConfig = getBucketConfig();
	});

	type PickItem = (typeof data.groupedItems)[0]['items'][0];

	/** Within a type group, sub-group items by CMC bucket (or 'all' for alpha-only). */
	function getBucketGroups(
		items: PickItem[]
	): Array<{ bucketLabel: string | null; items: PickItem[] }> {
		if (!bucketConfig) {
			// Config not loaded yet — fall back to alpha
			return [
				{
					bucketLabel: null,
					items: [...items].sort((a, b) => sortKey(a.cardName).localeCompare(sortKey(b.cardName)))
				}
			];
		}

		// Assign each item to a bucket label
		const labeled = items.map((item) => ({
			item,
			bucket: getItemBucketLabel(item.colors, item.typeLine, item.cmc ?? 0, bucketConfig!)
		}));

		// If ALL items have bucket='all', sort alpha with no sub-headers
		const nonAll = labeled.filter(
			(l) => l.bucket !== 'all' && l.bucket !== 'n/a' && l.bucket !== null
		);
		if (nonAll.length === 0) {
			return [
				{
					bucketLabel: null,
					items: [...items].sort((a, b) => sortKey(a.cardName).localeCompare(sortKey(b.cardName)))
				}
			];
		}

		// Group by bucket label preserving CMC bucket order
		const bucketMap = new Map<string, PickItem[]>();
		for (const { item, bucket } of labeled) {
			const key = bucket ?? 'all';
			if (!bucketMap.has(key)) bucketMap.set(key, []);
			bucketMap.get(key)!.push(item);
		}

		// Sort items alpha within each bucket
		for (const arr of bucketMap.values()) {
			arr.sort((a, b) => sortKey(a.cardName).localeCompare(sortKey(b.cardName)));
		}

		// Return groups in CMC-ascending order (by the min cmc of first item in each bucket)
		return [...bucketMap.entries()]
			.sort(([, a], [, b]) => (a[0]?.cmc ?? 0) - (b[0]?.cmc ?? 0))
			.map(([label, groupItems]) => ({
				bucketLabel: label === 'all' ? null : label,
				items: groupItems
			}));
	}

	/** For land groups: basics by subtype, non-basics alpha. */
	function getLandGroups(
		items: PickItem[]
	): Array<{ bucketLabel: string | null; items: PickItem[] }> {
		const basics: PickItem[] = [];
		const nonBasics: PickItem[] = [];
		for (const item of items) {
			if (item.typeLine.toLowerCase().includes('basic')) basics.push(item);
			else nonBasics.push(item);
		}

		const result: Array<{ bucketLabel: string | null; items: PickItem[] }> = [];

		// Group basics by subtype (Plains, Island, etc.)
		const bySubtype = new Map<string, PickItem[]>();
		for (const item of basics) {
			const sub = getLandSubtype(item.typeLine) ?? 'Basic Land';
			if (!bySubtype.has(sub)) bySubtype.set(sub, []);
			bySubtype.get(sub)!.push(item);
		}
		for (const [sub, arr] of [...bySubtype.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			result.push({
				bucketLabel: sub,
				items: arr.sort((a, b) => sortKey(a.cardName).localeCompare(sortKey(b.cardName)))
			});
		}

		// Non-basics: alpha, no sub-header
		if (nonBasics.length > 0) {
			result.push({
				bucketLabel: basics.length > 0 ? 'Non-basic' : null,
				items: nonBasics.sort((a, b) => sortKey(a.cardName).localeCompare(sortKey(b.cardName)))
			});
		}

		return result;
	}

	function getTypeGroups(items: PickItem[]) {
		const map = new Map<number, PickItem[]>();
		for (const item of items) {
			if (!map.has(item.typeOrder)) map.set(item.typeOrder, []);
			map.get(item.typeOrder)!.push(item);
		}
		return [...map.keys()]
			.sort((a, b) => a - b)
			.map((typeOrder) => ({
				typeOrder,
				bucketGroups:
					typeOrder === 9
						? getLandGroups(map.get(typeOrder)!)
						: getBucketGroups(map.get(typeOrder)!)
			}));
	}

	// ── Color filter ──────────────────────────────────────────────────────────────
	let selectedColors = $state(new Set<string>());

	const COLOR_LABELS: Record<string, string> = {
		W: 'White',
		U: 'Blue',
		B: 'Black',
		R: 'Red',
		G: 'Green',
		C: 'Colorless',
		M: 'Multi',
		L: 'Basic Land',
		NL: 'Nonbasic Land'
	};
	const COLOR_DOT: Record<string, string> = {
		W: '#c8b89a',
		U: '#79b8ff',
		B: '#b57abf',
		R: '#f87171',
		G: '#4ade80',
		C: '#8b9ba8',
		M: '#e3b341',
		L: '#6b7f5e',
		NL: '#a0855a'
	};
	const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G', 'M', 'C', 'NL', 'L'];

	function toggleColor(c: string) {
		const s = new Set(selectedColors);
		if (s.has(c)) s.delete(c);
		else s.add(c);
		selectedColors = s;
	}

	function isBasicLand(typeLine: string) {
		return /\bBasic\b/.test(typeLine) && /\bLand\b/.test(typeLine);
	}
	function isLand(typeLine: string) {
		return isLandOnlyTypeLine(typeLine);
	}

	function itemMatchesColorFilter(item: { colors: string; typeLine: string }): boolean {
		if (selectedColors.size === 0) return true;
		const basic = isBasicLand(item.typeLine);
		const land = isLand(item.typeLine);
		const colorless = item.colors === '' && !land;
		const multi = item.colors.length > 1;
		for (const c of selectedColors) {
			if (c === 'L' && basic) return true;
			if (c === 'NL' && land && !basic) return true;
			if (c === 'C' && colorless) return true;
			if (c === 'M' && multi) return true;
			if (c !== 'C' && c !== 'M' && c !== 'L' && c !== 'NL' && item.colors.includes(c)) return true;
		}
		return false;
	}

	let hidePulled = $state(false);
	let hideProxies = $state(false);
	let hideBasics = $state(false);
	let hideBinder = $state(false);

	let filteredGroupedItems = $derived.by(() => {
		return data.groupedItems
			.map((g) => ({
				...g,
				items: g.items.filter((item) => {
					if (selectedColors.size > 0 && !itemMatchesColorFilter(item)) return false;
					if (hidePulled && isPulled(item)) return false;
					if (hideProxies && item.location === 'proxy_box') return false;
					if (hideBasics && isBasicLand(item.typeLine)) return false;
					if (hideBinder && item.location === 'binder') return false;
					return true;
				})
			}))
			.filter((g) => g.items.length > 0);
	});

	let totalItems = $derived(data.groupedItems.reduce((s, g) => s + g.items.length, 0));
	let pulledCount = $derived(
		data.groupedItems.reduce((s, g) => s + g.items.filter((i) => isPulled(i)).length, 0)
	);
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Pick List</h1>
		<p class="page-subtitle">
			{pulledCount}/{totalItems} pulled
			{#if data.selectedDeckIds.length < data.allDecks.length}
				· {data.selectedDeckIds.length} deck{data.selectedDeckIds.length !== 1 ? 's' : ''}
			{:else}
				· All decks
			{/if}
		</p>
	</div>
	<div class="flex gap-2">
		<a href="/help#decks" class="btn btn-sm">How this works</a>
		<button class="btn" onclick={() => window.print()}>Print</button>
	</div>
</div>

<!-- Deck filter — dropdown with checkboxes -->
<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
	<span
		style="font-size:10px;color:var(--text-muted);font-weight:600;letter-spacing:.07em;text-transform:uppercase"
		>Decks</span
	>

	{#if deckDropdownOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			style="position:fixed;inset:0;z-index:49"
			onclick={() => (deckDropdownOpen = false)}
			onkeydown={(e) => e.key === 'Escape' && (deckDropdownOpen = false)}
		></div>
	{/if}

	<div style="position:relative">
		<button
			class="act-chip"
			style={selectedDeckIds.size > 0 && selectedDeckIds.size < data.allDecks.length
				? 'color:var(--accent);border-color:color-mix(in srgb,var(--accent) 50%,transparent);background:color-mix(in srgb,var(--accent) 8%,transparent)'
				: ''}
			onclick={() => (deckDropdownOpen = !deckDropdownOpen)}
			aria-expanded={deckDropdownOpen}
		>
			{#if selectedDeckIds.size === 0}
				No decks ▾
			{:else if selectedDeckIds.size === data.allDecks.length}
				All decks ▾
			{:else}
				{selectedDeckIds.size} deck{selectedDeckIds.size !== 1 ? 's' : ''} ▾
			{/if}
		</button>

		{#if deckDropdownOpen}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="deck-dropdown"
				onkeydown={(e) => e.key === 'Escape' && (deckDropdownOpen = false)}
			>
				<div class="deck-dropdown-actions">
					<button
						class="act-chip"
						style="font-size:11px"
						onclick={() => {
							const s = new Set(data.allDecks.map((d: { id: number }) => d.id));
							selectedDeckIds = s;
							applyFilters(s);
						}}>All</button
					>
					<button
						class="act-chip"
						style="font-size:11px"
						onclick={() => {
							const s = new Set<number>();
							selectedDeckIds = s;
							applyFilters(s);
						}}>None</button
					>
				</div>
				<div style="border-top:1px solid var(--border);margin:4px 0"></div>
				{#each data.allDecks as deck}
					<label class="deck-option">
						<input
							type="checkbox"
							checked={selectedDeckIds.has(deck.id)}
							onchange={() => toggleDeck(deck.id)}
						/>
						<span>{deck.name}</span>
					</label>
				{/each}
			</div>
		{/if}
	</div>

	{#if selectedDeckIds.size > 0 && selectedDeckIds.size < data.allDecks.length}
		<div style="display:flex;flex-wrap:wrap;gap:4px">
			{#each data.allDecks.filter((d: { id: number }) => selectedDeckIds.has(d.id)) as deck}
				<button
					class="act-chip"
					style="font-size:11px;color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent);background:color-mix(in srgb,var(--accent) 8%,transparent)"
					onclick={() => toggleDeck(deck.id)}
					title="Remove filter">{deck.name} ×</button
				>
			{/each}
		</div>
	{/if}
</div>

<!-- Color + Hide pulled filters -->
<div style="display:flex;align-items:center;gap:5px;margin-bottom:14px;flex-wrap:wrap">
	<span
		style="font-size:10px;color:var(--text-muted);font-weight:600;letter-spacing:.07em;text-transform:uppercase;margin-right:2px"
		>Color</span
	>
	{#each COLOR_ORDER as c}
		{@const active = selectedColors.has(c)}
		<button
			class="btn btn-sm"
			style="gap:5px;{active
				? 'border-color:var(--accent);color:var(--text);background:color-mix(in srgb,var(--accent) 8%,var(--surface-2))'
				: 'color:var(--text-muted)'}"
			onclick={() => toggleColor(c)}
		>
			<span
				style="display:inline-block;width:7px;height:7px;border-radius:50%;background:{COLOR_DOT[
					c
				]};flex-shrink:0;border:1px solid color-mix(in srgb,{COLOR_DOT[c]} 50%,var(--border))"
			></span>
			{COLOR_LABELS[c]}
		</button>
	{/each}
	{#if selectedColors.size > 0}
		<button
			class="btn btn-sm"
			style="color:var(--text-muted)"
			onclick={() => (selectedColors = new Set())}>Clear</button
		>
	{/if}

	<div style="width:1px;height:16px;background:var(--border);margin:0 4px;flex-shrink:0"></div>

	<button
		class="btn btn-sm"
		style={hidePulled
			? 'border-color:var(--success);color:var(--success);background:color-mix(in srgb,var(--success) 8%,var(--surface-2))'
			: 'color:var(--text-muted)'}
		onclick={() => (hidePulled = !hidePulled)}
		title={hidePulled ? 'Show pulled cards' : 'Hide pulled cards'}>Hide pulled</button
	>

	<button
		class="btn btn-sm"
		style={hideProxies
			? 'border-color:var(--gold);color:var(--gold);background:color-mix(in srgb,var(--gold) 8%,var(--surface-2))'
			: 'color:var(--text-muted)'}
		onclick={() => (hideProxies = !hideProxies)}
		title={hideProxies ? 'Show proxies' : 'Hide proxies'}>Hide proxies</button
	>

	<button
		class="btn btn-sm"
		style={hideBasics
			? 'border-color:var(--text-muted);color:var(--text);background:color-mix(in srgb,var(--text-muted) 8%,var(--surface-2))'
			: 'color:var(--text-muted)'}
		onclick={() => (hideBasics = !hideBasics)}
		title={hideBasics ? 'Show basic lands' : 'Hide basic lands'}>Hide basics</button
	>

	<button
		class="btn btn-sm"
		style={hideBinder
			? 'border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,var(--surface-2))'
			: 'color:var(--text-muted)'}
		onclick={() => (hideBinder = !hideBinder)}
		title={hideBinder ? 'Show $10+ binder cards' : 'Hide $10+ binder cards'}
		>Hide $10+ binder</button
	>
</div>

{#if data.groupedItems.length === 0}
	<div class="empty-state">
		<p>No cards to show. Add some decks or adjust your filters.</p>
		<a href="/decks/new" class="btn btn-primary">Import a Deck →</a>
	</div>
{:else}
	{#each filteredGroupedItems as group}
		{@const locationLabel = LOCATION_LABELS[group.location as CardLocation] ?? group.location}
		{@const groupPulled = group.items.filter((i) => isPulled(i)).length}

		<div class="picklist-section">
			<div class="picklist-group">
				<!-- Location group header: chip + count, no card background -->
				<div class="picklist-section-header loc-{group.location}">
					<span class="loc-chip loc-{group.location}">{locationLabel}</span>
					<span style="margin-left:auto;font-size:11px;font-weight:400;color:var(--text-muted)">
						{groupPulled}/{group.items.length}
					</span>
				</div>

				{#each getTypeGroups(group.items) as { typeOrder, bucketGroups }}
					<div class="picklist-type-header">{TYPE_LABELS[typeOrder] ?? 'Other'}</div>
					{#each bucketGroups as { bucketLabel, items: bucketItems }}
						{#if bucketLabel}
							<div class="picklist-bucket-header">CMC {bucketLabel}</div>
						{/if}
						{#if openMenuId !== null || copyPickerId !== null}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								style="position:fixed;inset:0;z-index:59"
								onclick={() => {
									openMenuId = null;
									copyPickerId = null;
								}}
								onkeydown={(e) => {
									if (e.key === 'Escape') {
										openMenuId = null;
										copyPickerId = null;
									}
								}}
							></div>
						{/if}
						{#each bucketItems as item (item.assignmentId)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="picklist-row"
								style={isPulled(item) ? 'opacity:0.45' : ''}
								oncontextmenu={(e) => openContextMenu(item.assignmentId, e)}
							>
								<input
									type="checkbox"
									class="picklist-check"
									checked={isPulled(item)}
									onchange={(e) => updatePulled(item.assignmentId, e.currentTarget.checked)}
								/>
								<div>
									<div class="picklist-card-name">
										<CardImage imageUri={item.imageUri} name={item.cardName}>
											{item.cardName}
											{#if item.foil}<span class="text-muted" style="font-size:10px">(F)</span>{/if}
											{#if item.isCommander}<span class="text-muted" style="font-size:10px"
													>(C)</span
												>{/if}
										</CardImage>
									</div>
									<div class="picklist-card-meta">
										{#if item.setCode}
											<button
												class="pl-printing-btn mono"
												disabled={menuBusy}
												onclick={(e) => openCopyPicker(item.assignmentId, e)}
												title={itemCollectionId(item) ? 'Change printing' : 'Assign copy'}
											>
												{item.setCode.toUpperCase()} #{item.collectorNumber}
											</button>
										{/if}
										{#if item.typeLine}
											· {item.typeLine}{/if}
										{#if item.cmc != null && item.cmc > 0}
											· CMC {item.cmc}{/if}
									</div>
								</div>
								<span class="picklist-deck-tag">{item.deckName}</span>
								<span
									style="display:inline-flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap"
								>
									<span class="status-dot status-dot-{isPulled(item) ? 'pulled' : itemStatus(item)}"
									></span>
									<span style="color:color-mix(in srgb,var(--text) 60%,var(--text-muted))"
										>{isPulled(item)
											? 'Pulled'
											: (STATUS_LABELS[itemStatus(item)] ?? itemStatus(item))}</span
									>
								</span>
								<!-- ⋯ action menu + copy picker -->
								<div style="position:relative;display:flex;justify-content:flex-end">
									<button
										class="pl-menu-btn"
										disabled={menuBusy}
										onclick={(e) => {
											e.stopPropagation();
											openMenu(item.assignmentId, e);
										}}
										title="More actions">⋯</button
									>

									{#if openMenuId === item.assignmentId}
										<div
											class="pl-menu-dropdown"
											class:pl-menu-dropdown--up={menuUpward}
											class:pl-menu-dropdown--context={contextMenuPosition !== null}
											style={contextMenuPosition
												? `left:${contextMenuPosition.x}px;top:${contextMenuPosition.y}px;right:auto;bottom:auto`
												: ''}
										>
											<button
												class="pl-menu-action"
												onclick={(e) => {
													openMenuId = null;
													openCopyPicker(item.assignmentId, e);
												}}
											>
												{itemCollectionId(item) ? 'Change printing…' : 'Assign copy…'}
											</button>
											<hr class="pl-menu-divider" />
											{#if itemStatus(item) !== 'proxied'}
												<button
													class="pl-menu-action"
													onclick={() =>
														applyAction(item.assignmentId, {
															status: 'proxied',
															collectionId: null,
															printStatus: 'need_print'
														})}
												>
													Proxy (needs print)
												</button>
											{:else if itemPrintStatus(item) === 'need_print'}
												<button
													class="pl-menu-action"
													onclick={() => markProxyPrinted(item.assignmentId, false)}
												>
													Mark as printed
												</button>
												{#if !isPulled(item)}
													<button
														class="pl-menu-action"
														onclick={() => markProxyPrinted(item.assignmentId, true)}
													>
														Mark printed + pulled
													</button>
												{/if}
											{:else}
												<button
													class="pl-menu-action"
													onclick={() =>
														applyAction(item.assignmentId, { printStatus: 'need_print' })}
												>
													Needs print
												</button>
											{/if}
											<hr class="pl-menu-divider" />
											<button
												class="pl-menu-action pl-menu-action--danger"
												onclick={() =>
													applyAction(item.assignmentId, { status: 'needed', collectionId: null })}
											>
												Unassign
											</button>
										</div>
									{/if}

									{#if copyPickerId === item.assignmentId}
										<div class="pl-copy-picker" class:pl-copy-picker--up={copyPickerUpward}>
											<div class="pl-copy-picker-header">Assign copy — {item.cardName}</div>
											{#if copyPickerLoading}
												<div class="pl-copy-msg">Loading…</div>
											{:else if copyPickerOptions.length === 0}
												<div class="pl-copy-msg">Not in collection</div>
											{:else}
												{#each copyPickerOptions as copy}
													{@const isCurrent = copy.id === item.collectionId}
													{@const canAssign = copy.available > 0 || isCurrent}
													{#if !canAssign && copy.conflicts.length > 0}
														<div class="pl-copy-conflict">
															<span class="mono" style="font-size:11px"
																>{copy.setCode.toUpperCase()} #{copy.collectorNumber}{#if copy.foil}
																	F{/if}</span
															>
															<span style="font-size:10px;color:var(--text-muted);font-style:italic"
																>used by {copy.conflicts.map((c) => c.deckName).join(', ')}</span
															>
															<div style="display:flex;gap:4px;margin-top:4px">
																<button
																	class="pl-copy-conflict-btn pl-copy-conflict-btn--take"
																	onclick={() => {
																		copyPickerId = null;
																		applyAction(item.assignmentId, {
																			status: 'assigned',
																			collectionId: copy.id,
																			override: true,
																			proxifyConflicts: true
																		});
																	}}
																>
																	Take it — they'll proxy
																</button>
																<button
																	class="pl-copy-conflict-btn pl-copy-conflict-btn--proxy"
																	onclick={() =>
																		applyAction(item.assignmentId, {
																			status: 'proxied',
																			collectionId: null
																		})}
																>
																	Proxy this slot
																</button>
															</div>
														</div>
													{:else}
														<button
															class="pl-copy-option"
															disabled={!canAssign}
															style="opacity:{canAssign ? 1 : 0.4}"
															onclick={() =>
																pickCopy(item.assignmentId, copy, itemCollectionId(item) ?? null)}
														>
															<span class="mono" style="font-size:12px">
																{copy.setCode.toUpperCase()} #{copy.collectorNumber}
																{#if copy.foil}<span style="color:var(--text-muted);font-size:10px">
																		F</span
																	>{/if}
																{#if isCurrent}<span style="color:var(--accent)"> ✓</span>{/if}
															</span>
															<span
																style="font-size:11px;color:{copy.available > 0
																	? 'var(--text-muted)'
																	: 'var(--error)'}"
															>
																{copy.available}/{copy.quantity}
															</span>
														</button>
													{/if}
												{/each}
											{/if}
										</div>
									{/if}
								</div>
							</div>
						{/each}
					{/each}
				{/each}
			</div>
		</div>
	{/each}
{/if}

<style>
	.deck-dropdown {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 50;
		min-width: 220px;
		max-height: 320px;
		overflow-y: auto;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		box-shadow: 0 4px 16px color-mix(in srgb, var(--text) 12%, transparent);
		padding: 6px 0 4px;
	}
	.deck-dropdown-actions {
		display: flex;
		gap: 6px;
		padding: 0 10px 6px;
	}
	.deck-option {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 12px;
		font-size: 13px;
		cursor: pointer;
		color: var(--text);
		white-space: nowrap;
	}
	.deck-option:hover {
		background: var(--surface-2);
	}
	.deck-option input[type='checkbox'] {
		cursor: pointer;
		accent-color: var(--accent);
		flex: none;
		width: auto;
		min-width: 0;
	}

	/* ── Row action menu ──────────────────────────────────────────────── */
	.pl-menu-btn {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-muted);
		font-size: 14px;
		padding: 0 2px;
		line-height: 1;
		border-radius: 3px;
		opacity: 0.15;
		transition: opacity 0.1s;
	}
	:global(.picklist-row:hover) .pl-menu-btn {
		opacity: 0.5;
	}
	.pl-menu-btn:hover {
		opacity: 1 !important;
		background: var(--surface-2);
	}
	.pl-menu-btn:disabled {
		opacity: 0.2;
		cursor: not-allowed;
	}

	.pl-printing-btn {
		display: inline;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: inherit;
		line-height: inherit;
	}
	.pl-printing-btn:hover:not(:disabled) {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.pl-printing-btn:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.pl-menu-dropdown {
		position: absolute;
		top: calc(100% + 3px);
		right: 0;
		z-index: 60;
		min-width: 160px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		box-shadow: 0 4px 16px color-mix(in srgb, var(--text) 15%, transparent);
		padding: 4px 0;
	}
	.pl-menu-dropdown--up {
		top: auto;
		bottom: calc(100% + 3px);
	}
	.pl-menu-dropdown--context {
		position: fixed;
		z-index: 80;
	}

	.pl-menu-action {
		display: block;
		width: 100%;
		padding: 6px 12px;
		background: none;
		border: none;
		cursor: pointer;
		font-size: 12px;
		color: var(--text-muted);
		text-align: left;
		white-space: nowrap;
	}
	.pl-menu-action:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.pl-menu-action--danger {
		color: color-mix(in srgb, var(--danger) 70%, var(--text-muted));
	}
	.pl-menu-action--danger:hover {
		color: var(--danger);
	}
	.pl-menu-divider {
		margin: 4px 0;
		border: none;
		border-top: 1px solid var(--border);
	}

	/* ── Copy picker ──────────────────────────────────────────────────── */
	.pl-copy-picker {
		position: absolute;
		top: calc(100% + 3px);
		right: 0;
		z-index: 60;
		min-width: 240px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		box-shadow: 0 4px 16px color-mix(in srgb, var(--text) 15%, transparent);
		padding: 4px 0;
	}
	.pl-copy-picker--up {
		top: auto;
		bottom: calc(100% + 3px);
	}
	.pl-copy-picker-header {
		padding: 6px 12px 5px;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
		border-bottom: 1px solid var(--border);
		margin-bottom: 2px;
	}
	.pl-copy-msg {
		padding: 8px 12px;
		font-size: 12px;
		color: var(--text-muted);
	}
	.pl-copy-option {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		padding: 5px 12px;
		background: none;
		border: none;
		text-align: left;
		color: var(--text);
		cursor: pointer;
		gap: 8px;
	}
	.pl-copy-option:not(:disabled):hover {
		background: var(--surface-2);
	}
	.pl-copy-conflict {
		padding: 6px 10px;
		margin: 2px 6px 4px;
		border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border));
		border-radius: 5px;
		background: color-mix(in srgb, var(--warning) 5%, var(--surface));
		font-size: 11px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.pl-copy-conflict-btn {
		padding: 3px 7px;
		font-size: 10px;
		font-weight: 600;
		border-radius: 3px;
		cursor: pointer;
		border: 1px solid transparent;
	}
	.pl-copy-conflict-btn--take {
		background: color-mix(in srgb, var(--accent) 12%, var(--surface));
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
		color: var(--accent);
	}
	.pl-copy-conflict-btn--proxy {
		background: color-mix(in srgb, var(--proxy) 10%, var(--surface));
		border-color: color-mix(in srgb, var(--proxy) 35%, transparent);
		color: var(--proxy);
	}

	@media print {
		:global(.app-nav),
		:global(.app-header),
		:global(.btn),
		:global(.page-header .btn) {
			display: none !important;
		}
		:global(.app-shell) {
			grid-template-columns: 1fr !important;
		}
		:global(.app-main) {
			padding: 0 !important;
		}
		.picklist-row {
			break-inside: avoid;
		}
		.picklist-section {
			break-before: auto;
		}
	}
</style>
