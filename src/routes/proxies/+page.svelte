<script lang="ts">
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { LOCATION_LABELS, LOCATION_ORDER } from '$lib/types';

	let { data }: { data: PageData } = $props();

	let tab = $state<'all' | 'print' | 'inventory' | 'real'>('all');
	type InventoryFilter = 'all' | 'available' | 'assigned' | 'reprint';
	let inventoryFilter = $state<InventoryFilter>('all');
	let inventorySearch = $state('');
	let inventoryBusy = $state<number | null>(null);
	let inventoryFeedback = $state<Record<number, string>>({});
	let reservationSelections = $state<Record<number, number>>({});
	let showAddInventory = $state(false);
	let editingInventoryId = $state<number | null>(null);
	let inventoryFormError = $state('');
	let printActionBusy = $state<number | null>(null);
	let printActionError = $state('');
	let inventoryCardSuggestions = $state<string[]>([]);
	let inventoryCardSearchTimer: ReturnType<typeof setTimeout> | null = null;
	let newInventory = $state({
		cardName: '',
		setCode: '',
		collectorNumber: '',
		location: 'proxy_box',
		printState: 'ready',
		notes: ''
	});
	let inventoryEdit = $state({
		setCode: '',
		collectorNumber: '',
		location: 'proxy_box',
		printState: 'ready',
		notes: ''
	});

	// ── Deck filter ───────────────────────────────────────────────────────
	let selectedDecks = $state(new Set<string>());
	let deckDropdownOpen = $state(false);

	const allDeckNames = $derived(data.groups.map((g) => g.deck).sort((a, b) => a.localeCompare(b)));

	function toggleDeck(name: string) {
		const s = new Set(selectedDecks);
		if (s.has(name)) s.delete(name);
		else s.add(name);
		selectedDecks = s;
	}

	const visibleGroups = $derived(
		selectedDecks.size === 0 ? data.groups : data.groups.filter((g) => selectedDecks.has(g.deck))
	);

	const visibleRealRows = $derived(
		selectedDecks.size === 0
			? data.realCardRows
			: data.realCardRows.filter((r) => selectedDecks.has(r.deckName))
	);

	// Consolidate realCardRows by card name so "Sol Ring proxied in 3 decks"
	// shows as one entry with multiple deck chips.
	type ConsolidatedRow = {
		cardName: string;
		decks: string[];
		realCard: (typeof data.realCardRows)[0]['realCard'];
	};

	const consolidatedReal = $derived.by(() => {
		const map = new Map<string, ConsolidatedRow>();
		for (const row of visibleRealRows) {
			if (!map.has(row.cardName)) {
				map.set(row.cardName, { cardName: row.cardName, decks: [], realCard: row.realCard });
			}
			map.get(row.cardName)!.decks.push(row.deckName);
		}
		const rows = [...map.values()];
		return {
			notOwned: rows
				.filter((r) => r.realCard.kind === 'not_owned')
				.sort((a, b) => a.cardName.localeCompare(b.cardName)),
			inDeck: rows
				.filter((r) => r.realCard.kind === 'in_deck')
				.sort((a, b) => a.cardName.localeCompare(b.cardName)),
			inCollection: rows
				.filter((r) => r.realCard.kind === 'in_collection')
				.sort((a, b) => a.cardName.localeCompare(b.cardName))
		};
	});

	// ── Print status ─────────────────────────────────────────────────────
	async function setPrintStatus(id: number, status: string | null) {
		await fetch(`/api/assignments/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ printStatus: status })
		});
		await invalidateAll();
	}

	async function markPrinted(assignmentId: number) {
		printActionBusy = assignmentId;
		printActionError = '';
		try {
			const response = await fetch('/api/proxy-inventory', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ assignmentId })
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => null);
				throw new Error(payload?.message ?? 'Could not record printed proxy');
			}
			await invalidateAll();
		} catch (error) {
			printActionError = error instanceof Error ? error.message : 'Could not record printed proxy';
		} finally {
			printActionBusy = null;
		}
	}

	async function inventoryRequest(
		inventoryId: number,
		method: 'PATCH' | 'DELETE',
		assignmentId?: number
	) {
		inventoryBusy = inventoryId;
		inventoryFeedback = { ...inventoryFeedback, [inventoryId]: '' };
		try {
			const response = await fetch(`/api/proxy-inventory/${inventoryId}`, {
				method,
				headers: method === 'PATCH' ? { 'Content-Type': 'application/json' } : undefined,
				body: method === 'PATCH' ? JSON.stringify({ assignmentId }) : undefined
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => null);
				throw new Error(payload?.message ?? 'Proxy inventory update failed');
			}
			await invalidateAll();
		} catch (error) {
			inventoryFeedback = {
				...inventoryFeedback,
				[inventoryId]: error instanceof Error ? error.message : 'Proxy inventory update failed'
			};
		} finally {
			inventoryBusy = null;
		}
	}

	function reserveInventory(
		inventoryId: number,
		options: (typeof data.inventory)[number]['reservationOptions']
	) {
		const assignmentId = reservationSelections[inventoryId] ?? options[0]?.assignmentId;
		if (!assignmentId) {
			inventoryFeedback = {
				...inventoryFeedback,
				[inventoryId]: 'No matching proxy assignment is available'
			};
			return;
		}
		inventoryRequest(inventoryId, 'PATCH', assignmentId);
	}

	function releaseInventory(inventoryId: number, cardName: string) {
		if (
			!confirm(
				`Release ${cardName} from this deck? The assignment will be marked as needing a print.`
			)
		)
			return;
		inventoryRequest(inventoryId, 'DELETE');
	}

	// Clicking the chip toggles: if already set, clears it; else sets it.
	function handlePrintChip(id: number, current: string | null, value: string) {
		if (current === value) {
			markPrinted(id);
		} else {
			setPrintStatus(id, value);
		}
	}

	async function addInventoryCopy() {
		inventoryFormError = '';
		try {
			const response = await fetch('/api/proxy-inventory', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(newInventory)
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => null);
				throw new Error(payload?.message ?? 'Could not add printed proxy');
			}
			newInventory = {
				cardName: '',
				setCode: '',
				collectorNumber: '',
				location: 'proxy_box',
				printState: 'ready',
				notes: ''
			};
			showAddInventory = false;
			await invalidateAll();
		} catch (error) {
			inventoryFormError = error instanceof Error ? error.message : 'Could not add printed proxy';
		}
	}

	function searchInventoryCardNames() {
		if (inventoryCardSearchTimer) clearTimeout(inventoryCardSearchTimer);
		const query = newInventory.cardName.trim();
		if (query.length < 2) {
			inventoryCardSuggestions = [];
			return;
		}
		inventoryCardSearchTimer = setTimeout(async () => {
			const response = await fetch(`/api/scryfall/search?q=${encodeURIComponent(query)}`);
			inventoryCardSuggestions = response.ok ? await response.json() : [];
		}, 200);
	}

	function beginInventoryEdit(item: (typeof data.inventory)[number]) {
		editingInventoryId = item.id;
		inventoryFormError = '';
		inventoryEdit = {
			setCode: item.setCode ?? '',
			collectorNumber: item.collectorNumber ?? '',
			location: item.location,
			printState: item.printState,
			notes: item.notes ?? ''
		};
	}

	async function saveInventoryEdit(inventoryId: number) {
		inventoryFormError = '';
		inventoryBusy = inventoryId;
		try {
			const response = await fetch(`/api/proxy-inventory/${inventoryId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'update', ...inventoryEdit })
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => null);
				throw new Error(payload?.message ?? 'Could not update printed proxy');
			}
			editingInventoryId = null;
			await invalidateAll();
		} catch (error) {
			inventoryFormError =
				error instanceof Error ? error.message : 'Could not update printed proxy';
		} finally {
			inventoryBusy = null;
		}
	}

	// ── Print queue / copy ────────────────────────────────────────────────
	const printGroups = $derived(
		visibleGroups
			.map((g) => ({
				deck: g.deck,
				items: g.items.filter(
					(i) => i.printStatus === 'need_print' || i.printStatus === 'need_reprint'
				)
			}))
			.filter((g) => g.items.length > 0)
	);

	let printCopyFeedback = $state<Record<string, string>>({});

	function buildPrintLines(groups: typeof printGroups) {
		const counts = new Map<string, number>();
		for (const g of groups) {
			for (const i of g.items) {
				counts.set(i.cardName, (counts.get(i.cardName) ?? 0) + 1);
			}
		}
		return [...counts.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, qty]) => `${qty} ${name}`)
			.join('\n');
	}

	async function copyPrintAll() {
		try {
			await navigator.clipboard.writeText(buildPrintLines(printGroups));
			printCopyFeedback = { ...printCopyFeedback, all: 'Copied!' };
		} catch {
			printCopyFeedback = { ...printCopyFeedback, all: 'Failed' };
		}
		setTimeout(() => {
			printCopyFeedback = { ...printCopyFeedback, all: '' };
		}, 2000);
	}

	async function copyPrintDeck(deck: string, items: (typeof printGroups)[0]['items']) {
		try {
			await navigator.clipboard.writeText(buildPrintLines([{ deck, items }]));
			printCopyFeedback = { ...printCopyFeedback, [deck]: 'Copied!' };
		} catch {
			printCopyFeedback = { ...printCopyFeedback, [deck]: 'Failed' };
		}
		setTimeout(() => {
			printCopyFeedback = { ...printCopyFeedback, [deck]: '' };
		}, 2000);
	}

	// ── All-proxies export ────────────────────────────────────────────────
	let selected = $state(new Set<number>());
	let copyFeedback = $state('');

	function toggleAll(ids: number[]) {
		const allSelected = ids.every((id) => selected.has(id));
		if (allSelected) ids.forEach((id) => selected.delete(id));
		else ids.forEach((id) => selected.add(id));
		selected = new Set(selected);
	}

	function exportList(idsToExport?: Set<number>) {
		// If no explicit selection, export all visible proxies
		const useAll = !idsToExport || idsToExport.size === 0;
		const lines: string[] = [];
		for (const group of visibleGroups) {
			for (const item of group.items) {
				if (!useAll && !idsToExport!.has(item.id)) continue;
				const set = item.proxySetCode ?? item.collSetCode;
				const cn = item.proxyCollectorNumber ?? item.collCollectorNumber;
				lines.push(
					set && cn ? `1 ${item.cardName} (${set.toUpperCase()}) ${cn}` : `1 ${item.cardName}`
				);
			}
		}
		return lines.join('\n');
	}

	async function copyExport() {
		try {
			await navigator.clipboard.writeText(exportList(selected.size > 0 ? selected : undefined));
			copyFeedback = selected.size > 0 ? `Copied ${selected.size}!` : 'Copied all!';
		} catch {
			copyFeedback = 'Failed';
		}
		setTimeout(() => {
			copyFeedback = '';
		}, 2000);
	}

	// ── Real Card Tracker section state ──────────────────────────────────
	let rctCollapsed = $state({ notOwned: false, inDeck: false, inCollection: false });
	let rctTooltip = $state<string | null>(null); // which section tooltip is open

	const RCT_DESCRIPTIONS: Record<string, string> = {
		notOwned:
			"You don't own any copies of this card. It will always be a proxy here unless you buy or trade for it.",
		inDeck:
			"You own a copy, but it's currently assigned to or pulled into another deck. You're proxying it here to avoid moving the physical card.",
		inCollection:
			"You own a copy that isn't committed to any deck — it's sitting in your binder or boxes. You chose to proxy it here rather than pulling the real card."
	};

	function toggleRctTooltip(key: string, e: MouseEvent) {
		e.stopPropagation();
		rctTooltip = rctTooltip === key ? null : key;
	}

	// ── Stats ─────────────────────────────────────────────────────────────
	const needPrint = $derived(
		visibleGroups.flatMap((g) => g.items).filter((i) => i.printStatus === 'need_print').length
	);
	const needReprint = $derived(
		visibleGroups.flatMap((g) => g.items).filter((i) => i.printStatus === 'need_reprint').length
	);
	const totalProxies = $derived(visibleGroups.reduce((s, g) => s + g.items.length, 0));
	const totalSelected = $derived(selected.size);
	const inventoryCounts = $derived({
		total: data.inventory.length,
		available: data.inventory.filter((item) => item.available).length,
		assigned: data.inventory.filter((item) => !item.available).length,
		reprint: data.inventory.filter((item) => item.printState === 'needs_reprint').length
	});
	const filteredInventory = $derived.by(() => {
		const query = inventorySearch.trim().toLowerCase();
		return data.inventory.filter((item) => {
			if (inventoryFilter === 'available' && !item.available) return false;
			if (inventoryFilter === 'assigned' && item.available) return false;
			if (inventoryFilter === 'reprint' && item.printState !== 'needs_reprint') return false;
			if (!query) return true;
			return (
				item.cardName.toLowerCase().includes(query) ||
				(item.setCode ?? '').toLowerCase().includes(query) ||
				(item.deckName ?? '').toLowerCase().includes(query)
			);
		});
	});
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Proxy Planner</h1>
		<p class="page-subtitle">
			{#if tab === 'inventory'}
				{inventoryCounts.total} physical copies · {inventoryCounts.available} available · {inventoryCounts.assigned}
				assigned
			{:else}
				{totalProxies} prox{totalProxies !== 1 ? 'ies' : 'y'}
				{#if needPrint > 0 || needReprint > 0}
					·
					{#if needPrint > 0}<span style="color:var(--warning)">{needPrint} to print</span>{/if}
					{#if needPrint > 0 && needReprint > 0}
						·
					{/if}
					{#if needReprint > 0}<span style="color:var(--error)">{needReprint} to reprint</span>{/if}
				{/if}
			{/if}
		</p>
	</div>
	{#if tab === 'all'}
		<button class="btn btn-primary" onclick={copyExport} disabled={totalProxies === 0}>
			{copyFeedback || (totalSelected > 0 ? `Copy selected (${totalSelected})` : 'Copy all')}
		</button>
	{:else if tab === 'print'}
		<button class="btn btn-primary" onclick={copyPrintAll} disabled={printGroups.length === 0}>
			{printCopyFeedback['all'] ||
				`Copy all${printGroups.length > 0 ? ` (${printGroups.reduce((s, g) => s + g.items.length, 0)})` : ''}`}
		</button>
	{/if}
</div>

<!-- Deck filter -->
{#if tab !== 'inventory' && allDeckNames.length > 1}
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
				style={selectedDecks.size > 0
					? 'color:var(--accent);border-color:color-mix(in srgb,var(--accent) 50%,transparent);background:color-mix(in srgb,var(--accent) 8%,transparent)'
					: ''}
				onclick={() => (deckDropdownOpen = !deckDropdownOpen)}
			>
				{selectedDecks.size === 0
					? 'All decks ▾'
					: `${selectedDecks.size} deck${selectedDecks.size !== 1 ? 's' : ''} ▾`}
			</button>
			{#if deckDropdownOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="proxy-deck-dropdown"
					onkeydown={(e) => e.key === 'Escape' && (deckDropdownOpen = false)}
				>
					<div style="padding:4px 10px 6px;display:flex;gap:6px">
						<button
							class="act-chip"
							style="font-size:11px"
							onclick={() => {
								selectedDecks = new Set();
								deckDropdownOpen = false;
							}}>All</button
						>
					</div>
					<div style="border-top:1px solid var(--border);margin-bottom:2px"></div>
					{#each allDeckNames as name}
						<label
							style="display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:13px;cursor:pointer;color:var(--text);white-space:nowrap"
						>
							<input
								type="checkbox"
								checked={selectedDecks.has(name)}
								onchange={() => toggleDeck(name)}
								style="cursor:pointer;accent-color:var(--accent);flex:none;width:auto"
							/>
							<span>{name}</span>
						</label>
					{/each}
				</div>
			{/if}
		</div>

		{#if selectedDecks.size > 0}
			<div style="display:flex;flex-wrap:wrap;gap:4px">
				{#each [...selectedDecks].sort() as name}
					<button
						class="act-chip"
						style="font-size:11px;color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent);background:color-mix(in srgb,var(--accent) 8%,transparent)"
						onclick={() => toggleDeck(name)}>{name} ×</button
					>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<!-- Tabs -->
<div class="tabs" style="margin-bottom:16px">
	<button class="tab" class:active={tab === 'all'} onclick={() => (tab = 'all')}>All Proxies</button
	>
	<button class="tab" class:active={tab === 'print'} onclick={() => (tab = 'print')}>
		Print Queue{#if needPrint + needReprint > 0}<span
				style="font-size:10px;color:var(--warning);font-weight:700;margin-left:4px"
				>({needPrint + needReprint})</span
			>{/if}
	</button>
	<button class="tab" class:active={tab === 'inventory'} onclick={() => (tab = 'inventory')}>
		Proxy Inventory <span class="tab-count">{inventoryCounts.total}</span>
	</button>
	<button class="tab" class:active={tab === 'real'} onclick={() => (tab = 'real')}
		>Real Card Tracker</button
	>
</div>

{#if printActionError}
	<div class="alert alert-error" style="margin-bottom:12px" role="alert">{printActionError}</div>
{/if}

<!-- ── All Proxies ─────────────────────────────────────────────────────────── -->
{#if tab === 'all'}
	{#if visibleGroups.length === 0}
		<div class="empty-state">
			{selectedDecks.size > 0
				? 'No proxied cards in the selected decks.'
				: 'No proxied cards found.'}
		</div>
	{:else}
		{#each visibleGroups as group}
			<div class="card mb-2">
				<div class="proxy-group-header">
					<strong style="font-size:14px">{group.deck}</strong>
					<span style="font-size:12px;color:var(--text-muted)"
						>{group.items.length} card{group.items.length !== 1 ? 's' : ''}</span
					>
					<button
						class="btn btn-sm"
						style="margin-left:auto"
						onclick={() => toggleAll(group.items.map((i) => i.id))}
					>
						{group.items.every((i) => selected.has(i.id)) ? 'Deselect all' : 'Select all'}
					</button>
				</div>

				<table class="proxy-table">
					<tbody>
						{#each group.items as item}
							<tr>
								<td style="width:24px">
									<input
										type="checkbox"
										checked={selected.has(item.id)}
										onchange={() => {
											if (selected.has(item.id)) selected.delete(item.id);
											else selected.add(item.id);
											selected = new Set(selected);
										}}
										style="accent-color:var(--proxy)"
									/>
								</td>
								<td class="proxy-name">
									{item.cardName}
									{#if item.note}<span class="proxy-note"> — {item.note}</span>{/if}
								</td>
								<td class="proxy-set">
									{#if item.proxySetCode ?? item.collSetCode}
										<span class="mono"
											>{(item.proxySetCode ?? item.collSetCode)?.toUpperCase()} #{item.proxyCollectorNumber ??
												item.collCollectorNumber}</span
										>
									{/if}
								</td>
								<td class="proxy-print-col">
									<!-- Active chips record the completed print; inactive chips add work. -->
									<button
										class="proxy-print-chip"
										class:proxy-print-chip--active-warn={item.printStatus === 'need_print'}
										onclick={() => handlePrintChip(item.id, item.printStatus, 'need_print')}
										title={item.printStatus === 'need_print'
											? 'Record this proxy as printed'
											: 'Mark as needs printing'}>Print</button
									>
									<button
										class="proxy-print-chip"
										class:proxy-print-chip--active-err={item.printStatus === 'need_reprint'}
										onclick={() => handlePrintChip(item.id, item.printStatus, 'need_reprint')}
										title={item.printStatus === 'need_reprint'
											? 'Record this proxy as reprinted'
											: 'Mark as needs reprinting'}>Reprint</button
									>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/each}
	{/if}

	<!-- ── Print Queue ─────────────────────────────────────────────────────────── -->
{:else if tab === 'print'}
	{#if printGroups.length === 0}
		<div class="empty-state">
			No cards flagged for printing. Use the Print / Reprint chips in All Proxies to flag cards.
		</div>
	{:else}
		{#each printGroups as group}
			<div class="card mb-2">
				<div class="proxy-group-header">
					<strong style="font-size:14px">{group.deck}</strong>
					<span style="font-size:12px;color:var(--text-muted)"
						>{group.items.length} card{group.items.length !== 1 ? 's' : ''}</span
					>
					<button
						class="btn btn-sm"
						style="margin-left:auto"
						onclick={() => copyPrintDeck(group.deck, group.items)}
					>
						{printCopyFeedback[group.deck] || 'Copy'}
					</button>
				</div>
				<table class="proxy-table">
					<tbody>
						{#each group.items as item}
							<tr>
								<td style="width:60px">
									<span
										class="proxy-status-chip proxy-status-chip--{item.printStatus === 'need_reprint'
											? 'err'
											: 'warn'}"
									>
										{item.printStatus === 'need_reprint' ? 'Reprint' : 'Print'}
									</span>
								</td>
								<td class="proxy-name">
									{item.cardName}
									{#if item.note}<span class="proxy-note"> — {item.note}</span>{/if}
								</td>
								<td class="proxy-set">
									{#if item.proxySetCode ?? item.collSetCode}
										<span class="mono"
											>{(item.proxySetCode ?? item.collSetCode)?.toUpperCase()} #{item.proxyCollectorNumber ??
												item.collCollectorNumber}</span
										>
									{/if}
								</td>
								<td style="width:92px;text-align:right">
									<button
										class="btn btn-sm"
										disabled={printActionBusy === item.id}
										onclick={() => markPrinted(item.id)}
									>
										{printActionBusy === item.id ? 'Saving...' : 'Printed'}
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/each}

		<div class="card" style="margin-top:4px">
			<div
				style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px"
			>
				Combined copy list <span style="font-weight:400;text-transform:none"
					>(duplicates merged)</span
				>
			</div>
			<pre
				style="font-size:12px;font-family:monospace;color:var(--text);line-height:1.7;white-space:pre-wrap;margin:0">{buildPrintLines(
					printGroups
				)}</pre>
		</div>
	{/if}

	<!-- ── Physical proxy inventory ────────────────────────────────────────────── -->
{:else if tab === 'inventory'}
	<div class="inventory-toolbar">
		<input
			class="inventory-search"
			type="search"
			bind:value={inventorySearch}
			placeholder="Search proxy inventory..."
			aria-label="Search proxy inventory"
		/>
		<div class="inventory-segments" aria-label="Filter proxy inventory">
			<button class:active={inventoryFilter === 'all'} onclick={() => (inventoryFilter = 'all')}>
				All <span>{inventoryCounts.total}</span>
			</button>
			<button
				class:active={inventoryFilter === 'available'}
				onclick={() => (inventoryFilter = 'available')}
			>
				Available <span>{inventoryCounts.available}</span>
			</button>
			<button
				class:active={inventoryFilter === 'assigned'}
				onclick={() => (inventoryFilter = 'assigned')}
			>
				Assigned <span>{inventoryCounts.assigned}</span>
			</button>
			<button
				class:active={inventoryFilter === 'reprint'}
				onclick={() => (inventoryFilter = 'reprint')}
			>
				Needs reprint <span>{inventoryCounts.reprint}</span>
			</button>
		</div>
		<button
			class="btn btn-primary btn-sm inventory-add-button"
			onclick={() => {
				showAddInventory = !showAddInventory;
				editingInventoryId = null;
				inventoryFormError = '';
			}}
		>
			{showAddInventory ? 'Cancel' : 'Add copy'}
		</button>
	</div>

	{#if showAddInventory}
		<form
			class="inventory-editor"
			onsubmit={(event) => {
				event.preventDefault();
				addInventoryCopy();
			}}
		>
			<label class="inventory-field inventory-field--name">
				<span>Card</span>
				<input
					required
					bind:value={newInventory.cardName}
					oninput={searchInventoryCardNames}
					list="proxy-card-suggestions"
					placeholder="Card name"
				/>
				<datalist id="proxy-card-suggestions">
					{#each inventoryCardSuggestions as name}
						<option value={name}></option>
					{/each}
				</datalist>
			</label>
			<label class="inventory-field">
				<span>Set</span>
				<input bind:value={newInventory.setCode} maxlength="8" placeholder="Optional" />
			</label>
			<label class="inventory-field">
				<span>Collector #</span>
				<input bind:value={newInventory.collectorNumber} placeholder="Optional" />
			</label>
			<label class="inventory-field">
				<span>Print state</span>
				<select bind:value={newInventory.printState}>
					<option value="ready">Ready</option>
					<option value="needs_reprint">Needs reprint</option>
				</select>
			</label>
			<label class="inventory-field">
				<span>Home</span>
				<select bind:value={newInventory.location}>
					{#each LOCATION_ORDER as location}
						<option value={location}>{LOCATION_LABELS[location]}</option>
					{/each}
				</select>
			</label>
			<label class="inventory-field inventory-field--notes">
				<span>Notes</span>
				<input bind:value={newInventory.notes} placeholder="Optional" />
			</label>
			<div class="inventory-editor-actions">
				<button class="btn btn-primary btn-sm" type="submit">Add copy</button>
			</div>
			{#if inventoryFormError}
				<div class="inventory-form-error" role="alert">{inventoryFormError}</div>
			{/if}
		</form>
	{/if}

	{#if filteredInventory.length === 0}
		<div class="empty-state">
			{data.inventory.length === 0
				? 'No printed proxy inventory yet.'
				: 'No proxy copies match this filter.'}
		</div>
	{:else}
		<div class="inventory-table-wrap">
			<table class="inventory-table">
				<thead>
					<tr>
						<th>Card</th>
						<th>Printing</th>
						<th>Print state</th>
						<th>Assignment</th>
						<th>Home</th>
						<th><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each filteredInventory as item (item.id)}
						<tr title={`Inventory copy #${item.id}`}>
							<td class="inventory-name">
								{item.cardName}
								{#if item.notes}<span>{item.notes}</span>{/if}
							</td>
							<td class="inventory-printing">
								{#if item.setCode && item.collectorNumber}
									<span class="mono">{item.setCode.toUpperCase()} #{item.collectorNumber}</span>
								{:else}
									<span class="inventory-muted">Unspecified</span>
								{/if}
							</td>
							<td class="inventory-condition">
								<span class="inventory-state inventory-state--{item.printState}">
									{item.printState === 'needs_reprint' ? 'Needs reprint' : 'Ready'}
								</span>
							</td>
							<td class="inventory-assignment">
								<span class="inventory-state inventory-state--{item.assignmentState}">
									{item.assignmentState === 'in_deck'
										? 'In deck'
										: item.assignmentState === 'reserved'
											? 'Reserved'
											: 'Available'}
								</span>
								{#if item.deckId && item.deckName}
									<a href={`/decks/${item.deckId}`}>{item.deckName}</a>
								{/if}
							</td>
							<td class="inventory-home">
								<span class="loc-chip loc-{item.location}">{item.locationLabel}</span>
							</td>
							<td class="inventory-actions">
								<button class="btn btn-sm" onclick={() => beginInventoryEdit(item)}> Edit </button>
								{#if item.available}
									{#if item.reservationOptions.length > 0}
										{#if item.reservationOptions.length > 1}
											<select
												aria-label={`Deck assignment for ${item.cardName}`}
												value={reservationSelections[item.id] ??
													item.reservationOptions[0].assignmentId}
												onchange={(event) => {
													reservationSelections = {
														...reservationSelections,
														[item.id]: Number(event.currentTarget.value)
													};
												}}
											>
												{#each item.reservationOptions as option}
													<option value={option.assignmentId}>{option.deckName}</option>
												{/each}
											</select>
										{/if}
										<button
											class="btn btn-sm"
											disabled={inventoryBusy === item.id}
											onclick={() => reserveInventory(item.id, item.reservationOptions)}
										>
											{inventoryBusy === item.id ? 'Reserving...' : 'Reserve'}
										</button>
									{:else}
										<span class="inventory-muted">No matching assignment</span>
									{/if}
								{:else if item.assignmentState === 'reserved'}
									<button
										class="btn btn-sm"
										disabled={inventoryBusy === item.id}
										onclick={() => releaseInventory(item.id, item.cardName)}
									>
										{inventoryBusy === item.id ? 'Releasing...' : 'Release'}
									</button>
								{:else}
									<button
										class="btn btn-sm"
										disabled
										title="Unpack this proxy from its deck before releasing it"
									>
										Unpack first
									</button>
								{/if}
								{#if inventoryFeedback[item.id]}
									<span class="inventory-action-error" role="alert">
										{inventoryFeedback[item.id]}
									</span>
								{/if}
							</td>
						</tr>
						{#if editingInventoryId === item.id}
							<tr class="inventory-edit-row">
								<td colspan="6">
									<form
										class="inventory-editor inventory-editor--row"
										onsubmit={(event) => {
											event.preventDefault();
											saveInventoryEdit(item.id);
										}}
									>
										<div class="inventory-edit-title">Edit {item.cardName}</div>
										<label class="inventory-field">
											<span>Set</span>
											<input
												bind:value={inventoryEdit.setCode}
												maxlength="8"
												placeholder="Optional"
											/>
										</label>
										<label class="inventory-field">
											<span>Collector #</span>
											<input bind:value={inventoryEdit.collectorNumber} placeholder="Optional" />
										</label>
										<label class="inventory-field">
											<span>Print state</span>
											<select bind:value={inventoryEdit.printState}>
												<option value="ready">Ready</option>
												<option value="needs_reprint">Needs reprint</option>
											</select>
										</label>
										<label class="inventory-field">
											<span>Home</span>
											<select bind:value={inventoryEdit.location}>
												{#each LOCATION_ORDER as location}
													<option value={location}>{LOCATION_LABELS[location]}</option>
												{/each}
											</select>
										</label>
										<label class="inventory-field inventory-field--notes">
											<span>Notes</span>
											<input bind:value={inventoryEdit.notes} placeholder="Optional" />
										</label>
										<div class="inventory-editor-actions">
											<button
												class="btn btn-primary btn-sm"
												type="submit"
												disabled={inventoryBusy === item.id}
											>
												{inventoryBusy === item.id ? 'Saving...' : 'Save'}
											</button>
											<button
												class="btn btn-sm"
												type="button"
												onclick={() => {
													editingInventoryId = null;
													inventoryFormError = '';
												}}
											>
												Cancel
											</button>
										</div>
										{#if inventoryFormError}
											<div class="inventory-form-error" role="alert">{inventoryFormError}</div>
										{/if}
									</form>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<!-- ── Real Card Tracker ───────────────────────────────────────────────────── -->
{:else if tab === 'real'}
	{#if visibleRealRows.length === 0}
		<div class="empty-state">No proxied cards to track.</div>
	{:else}
		{@const { notOwned, inDeck, inCollection } = consolidatedReal}

		<!-- Summary bar -->
		<div class="rct-summary">
			<span class="rct-summary-item rct-summary--danger">
				<span class="rct-dot"></span>{notOwned.length} not owned
			</span>
			<span class="rct-summary-item rct-summary--deck">
				<span class="rct-dot"></span>{inDeck.length} in another deck
			</span>
			<span class="rct-summary-item rct-summary--coll">
				<span class="rct-dot"></span>{inCollection.length} in collection
			</span>
		</div>

		<!-- NOT OWNED -->
		{#if notOwned.length > 0}
			<div class="rct-section rct-section--danger">
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="rct-section-header"
					onclick={() => (rctCollapsed.notOwned = !rctCollapsed.notOwned)}
					onkeydown={(e) => e.key === 'Enter' && (rctCollapsed.notOwned = !rctCollapsed.notOwned)}
				>
					<span class="rct-section-icon">✗</span>
					Not Owned
					<button
						class="rct-info-btn"
						onclick={(e) => toggleRctTooltip('notOwned', e)}
						title={RCT_DESCRIPTIONS.notOwned}>ⓘ</button
					>
					<span class="rct-section-count">{notOwned.length}</span>
					<span class="rct-chevron">{rctCollapsed.notOwned ? '▶' : '▼'}</span>
				</div>
				{#if rctTooltip === 'notOwned'}
					<div class="rct-tooltip-banner rct-tooltip--danger">{RCT_DESCRIPTIONS.notOwned}</div>
				{/if}
				{#if !rctCollapsed.notOwned}
					<div class="rct-section-body">
						{#each notOwned as row}
							<div class="rct-row">
								<span class="rct-card-name">{row.cardName}</span>
								<div class="rct-deck-chips">
									{#each row.decks as deck}
										<span class="rct-deck-chip">{deck}</span>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- IN ANOTHER DECK -->
		{#if inDeck.length > 0}
			<div class="rct-section rct-section--deck">
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="rct-section-header"
					onclick={() => (rctCollapsed.inDeck = !rctCollapsed.inDeck)}
					onkeydown={(e) => e.key === 'Enter' && (rctCollapsed.inDeck = !rctCollapsed.inDeck)}
				>
					<span class="rct-section-icon">⇄</span>
					In Another Deck
					<button
						class="rct-info-btn"
						onclick={(e) => toggleRctTooltip('inDeck', e)}
						title={RCT_DESCRIPTIONS.inDeck}>ⓘ</button
					>
					<span class="rct-section-count">{inDeck.length}</span>
					<span class="rct-chevron">{rctCollapsed.inDeck ? '▶' : '▼'}</span>
				</div>
				{#if rctTooltip === 'inDeck'}
					<div class="rct-tooltip-banner rct-tooltip--deck">{RCT_DESCRIPTIONS.inDeck}</div>
				{/if}
				{#if !rctCollapsed.inDeck}
					<div class="rct-section-body">
						{#each inDeck as row}
							{@const rc = row.realCard}
							<div class="rct-row">
								<span class="rct-card-name">{row.cardName}</span>
								<span
									class="rct-real-status rct-real-status--{rc.kind === 'in_deck' && rc.pulled
										? 'pulled'
										: 'assigned'}"
								>
									{#if rc.kind === 'in_deck'}
										{rc.pulled ? '✓ Pulled' : '→ Assigned'} · {rc.deckName}
									{/if}
								</span>
								<div class="rct-deck-chips">
									{#each row.decks as deck}
										<span class="rct-deck-chip">{deck}</span>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- IN COLLECTION -->
		{#if inCollection.length > 0}
			<div class="rct-section rct-section--coll">
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="rct-section-header"
					onclick={() => (rctCollapsed.inCollection = !rctCollapsed.inCollection)}
					onkeydown={(e) =>
						e.key === 'Enter' && (rctCollapsed.inCollection = !rctCollapsed.inCollection)}
				>
					<span class="rct-section-icon">▣</span>
					In Your Collection
					<button
						class="rct-info-btn"
						onclick={(e) => toggleRctTooltip('inCollection', e)}
						title={RCT_DESCRIPTIONS.inCollection}>ⓘ</button
					>
					<span class="rct-section-count">{inCollection.length}</span>
					<span class="rct-chevron">{rctCollapsed.inCollection ? '▶' : '▼'}</span>
				</div>
				{#if rctTooltip === 'inCollection'}
					<div class="rct-tooltip-banner rct-tooltip--coll">{RCT_DESCRIPTIONS.inCollection}</div>
				{/if}
				{#if !rctCollapsed.inCollection}
					<div class="rct-section-body">
						{#each inCollection as row}
							{@const rc = row.realCard}
							<div class="rct-row">
								<span class="rct-card-name">{row.cardName}</span>
								<span class="rct-real-status rct-real-status--coll">
									{#if rc.kind === 'in_collection'}
										{rc.location}{rc.qty > 1 ? ` ×${rc.qty}` : ''}
									{/if}
								</span>
								<div class="rct-deck-chips">
									{#each row.decks as deck}
										<span class="rct-deck-chip">{deck}</span>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	{/if}
{/if}

<style>
	.tab-count {
		margin-left: 4px;
		font-size: 10px;
		color: var(--text-muted);
	}

	.proxy-group-header {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
	}

	.proxy-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	.proxy-table tr {
		border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
	}
	.proxy-table tr:last-child {
		border-bottom: none;
	}
	.proxy-table td {
		padding: 5px 6px 5px 0;
		vertical-align: middle;
	}

	.proxy-name {
		font-weight: 500;
		min-width: 0;
	}
	.proxy-note {
		font-weight: 400;
		font-style: italic;
		color: var(--text-muted);
		font-size: 12px;
	}
	.proxy-set {
		color: var(--text-muted);
		font-size: 11px;
		white-space: nowrap;
		width: 120px;
	}

	/* ── Print status chips ────────────────────────────────────────────────── */
	.proxy-print-col {
		white-space: nowrap;
		width: 120px;
		text-align: right;
	}
	.proxy-print-chip {
		display: inline-block;
		padding: 2px 7px;
		font-size: 10px;
		font-weight: 600;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		margin-left: 4px;
		transition:
			background 0.1s,
			color 0.1s,
			border-color 0.1s;
	}
	.proxy-print-chip:hover {
		color: var(--text);
		border-color: var(--text-muted);
	}
	.proxy-print-chip--active-warn {
		background: color-mix(in srgb, var(--warning) 12%, transparent);
		border-color: var(--warning);
		color: var(--warning);
	}
	.proxy-print-chip--active-err {
		background: color-mix(in srgb, var(--error) 12%, transparent);
		border-color: var(--error);
		color: var(--error);
	}

	.proxy-status-chip {
		display: inline-block;
		padding: 1px 6px;
		font-size: 10px;
		font-weight: 700;
		border-radius: 3px;
		white-space: nowrap;
	}
	.proxy-status-chip--warn {
		background: color-mix(in srgb, var(--warning) 12%, transparent);
		color: var(--warning);
	}
	.proxy-status-chip--err {
		background: color-mix(in srgb, var(--error) 12%, transparent);
		color: var(--error);
	}

	/* ── Physical proxy inventory ─────────────────────────────────────────── */
	.inventory-toolbar {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 14px;
		flex-wrap: wrap;
	}
	.inventory-search {
		width: min(320px, 100%);
		flex: 0 1 320px;
	}
	.inventory-add-button {
		margin-left: auto;
	}
	.inventory-segments {
		display: inline-flex;
		align-items: stretch;
		border: 1px solid var(--border);
		border-radius: 5px;
		overflow: hidden;
	}
	.inventory-segments button {
		min-height: 30px;
		padding: 4px 9px;
		border: 0;
		border-right: 1px solid var(--border);
		border-radius: 0;
		background: var(--surface);
		color: var(--text-muted);
		font-size: 11px;
		cursor: pointer;
		white-space: nowrap;
	}
	.inventory-segments button:last-child {
		border-right: 0;
	}
	.inventory-segments button:hover {
		color: var(--text);
		background: var(--surface-2);
	}
	.inventory-segments button.active {
		color: var(--text);
		background: var(--surface-raised);
		font-weight: 600;
	}
	.inventory-segments button span {
		margin-left: 3px;
		color: var(--text-muted);
		font-size: 10px;
	}
	.inventory-editor {
		display: grid;
		grid-template-columns: minmax(180px, 1.5fr) 90px 110px 130px minmax(150px, 1fr);
		gap: 10px;
		align-items: end;
		padding: 12px 10px;
		margin-bottom: 14px;
		border-block: 1px solid var(--border);
		background: var(--surface);
	}
	.inventory-editor--row {
		margin: 0;
		border: 0;
		background: var(--surface-2);
	}
	.inventory-edit-title {
		grid-column: 1 / -1;
		color: var(--text);
		font-size: 12px;
		font-weight: 600;
	}
	.inventory-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.inventory-field > span {
		color: var(--text-muted);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
	}
	.inventory-field input,
	.inventory-field select {
		width: 100%;
		height: 30px;
		font-size: 11px;
	}
	.inventory-field--notes {
		grid-column: span 2;
	}
	.inventory-editor-actions {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.inventory-form-error {
		grid-column: 1 / -1;
		color: var(--error);
		font-size: 11px;
	}
	.inventory-table-wrap {
		border-top: 1px solid var(--border);
	}
	.inventory-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	.inventory-table th {
		padding: 7px 10px;
		color: var(--text-muted);
		font-size: 10px;
		font-weight: 600;
		text-align: left;
		text-transform: uppercase;
		border-bottom: 1px solid var(--border);
	}
	.inventory-table td {
		padding: 7px 10px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
		vertical-align: middle;
	}
	.inventory-table tbody tr:hover {
		background: color-mix(in srgb, var(--text) 3%, transparent);
	}
	.inventory-table tbody tr.inventory-edit-row:hover {
		background: transparent;
	}
	.inventory-edit-row > td {
		padding: 0;
	}
	.inventory-name {
		font-size: 13px;
		font-weight: 600;
	}
	.inventory-name > span {
		display: block;
		color: var(--text-muted);
		font-size: 11px;
		font-weight: 400;
	}
	.inventory-printing,
	.inventory-home {
		white-space: nowrap;
	}
	.inventory-muted {
		color: var(--text-muted);
	}
	.inventory-state {
		display: inline-flex;
		align-items: center;
		min-height: 20px;
		padding: 1px 6px;
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text-muted);
		font-size: 10px;
		font-weight: 600;
		white-space: nowrap;
	}
	.inventory-state--ready,
	.inventory-state--available {
		color: var(--success);
		border-color: color-mix(in srgb, var(--success) 35%, var(--border));
		background: color-mix(in srgb, var(--success) 7%, transparent);
	}
	.inventory-state--needs_reprint {
		color: var(--error);
		border-color: color-mix(in srgb, var(--error) 35%, var(--border));
		background: color-mix(in srgb, var(--error) 7%, transparent);
	}
	.inventory-state--reserved {
		color: var(--assigned);
		border-color: color-mix(in srgb, var(--assigned) 35%, var(--border));
		background: color-mix(in srgb, var(--assigned) 7%, transparent);
	}
	.inventory-state--in_deck {
		color: var(--proxy);
		border-color: color-mix(in srgb, var(--proxy) 35%, var(--border));
		background: color-mix(in srgb, var(--proxy) 7%, transparent);
	}
	.inventory-assignment {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.inventory-assignment a {
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.inventory-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		min-width: 116px;
	}
	.inventory-actions select {
		max-width: 150px;
		height: 28px;
		font-size: 11px;
	}
	.inventory-action-error {
		max-width: 220px;
		color: var(--error);
		font-size: 10px;
		line-height: 1.25;
	}

	/* ── Real Card Tracker ─────────────────────────────────────────────────── */
	.rct-summary {
		display: flex;
		gap: 20px;
		margin-bottom: 18px;
		flex-wrap: wrap;
	}
	.rct-summary-item {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		font-weight: 600;
	}
	.rct-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.rct-summary--danger {
		color: var(--danger);
	}
	.rct-summary--danger .rct-dot {
		background: var(--danger);
	}
	.rct-summary--deck {
		color: var(--assigned);
	}
	.rct-summary--deck .rct-dot {
		background: var(--assigned);
	}
	.rct-summary--coll {
		color: var(--text-muted);
	}
	.rct-summary--coll .rct-dot {
		background: var(--text-muted);
	}

	.rct-section {
		margin-bottom: 16px;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid var(--border);
	}
	.rct-section-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
		user-select: none;
	}
	.rct-section-icon {
		font-size: 12px;
		opacity: 0.8;
	}
	.rct-section-count {
		margin-left: auto;
		font-size: 11px;
		font-weight: 600;
		opacity: 0.7;
	}
	.rct-chevron {
		font-size: 9px;
		opacity: 0.6;
		flex-shrink: 0;
	}
	.rct-info-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		font-size: 11px;
		background: none;
		border: none;
		cursor: pointer;
		opacity: 0.5;
		padding: 0;
		text-transform: none;
		letter-spacing: 0;
		font-weight: 400;
		flex-shrink: 0;
	}
	.rct-info-btn:hover {
		opacity: 1;
	}
	.rct-tooltip-banner {
		padding: 8px 14px;
		font-size: 12px;
		font-weight: 400;
		letter-spacing: 0;
		text-transform: none;
		line-height: 1.5;
		border-bottom: 1px solid var(--border);
	}
	.rct-tooltip--danger {
		background: color-mix(in srgb, var(--danger) 6%, var(--surface));
		color: color-mix(in srgb, var(--danger) 80%, var(--text));
	}
	.rct-tooltip--deck {
		background: color-mix(in srgb, var(--assigned) 6%, var(--surface));
		color: color-mix(in srgb, var(--assigned) 80%, var(--text));
	}
	.rct-tooltip--coll {
		background: color-mix(in srgb, var(--text-muted) 5%, var(--surface));
		color: var(--text-muted);
	}

	.rct-section--danger .rct-section-header {
		background: color-mix(in srgb, var(--danger) 8%, var(--surface));
		color: var(--danger);
		border-bottom-color: color-mix(in srgb, var(--danger) 20%, var(--border));
	}
	.rct-section--deck .rct-section-header {
		background: color-mix(in srgb, var(--assigned) 8%, var(--surface));
		color: var(--assigned);
		border-bottom-color: color-mix(in srgb, var(--assigned) 20%, var(--border));
	}
	.rct-section--coll .rct-section-header {
		background: color-mix(in srgb, var(--text-muted) 6%, var(--surface));
		color: var(--text-muted);
		border-bottom-color: var(--border);
	}

	.rct-section-body {
		background: var(--surface);
	}

	.rct-row {
		display: grid;
		grid-template-columns: 1fr auto auto;
		align-items: center;
		gap: 12px;
		padding: 7px 14px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
		transition: background 0.08s;
	}
	.rct-row:last-child {
		border-bottom: none;
	}
	.rct-row:hover {
		background: color-mix(in srgb, var(--text) 3%, transparent);
	}

	.rct-card-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rct-real-status {
		font-size: 11px;
		font-weight: 500;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.rct-real-status--pulled {
		color: var(--success);
	}
	.rct-real-status--assigned {
		color: var(--assigned);
	}
	.rct-real-status--coll {
		color: var(--text-muted);
	}

	.rct-deck-chips {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		justify-content: flex-end;
		flex-shrink: 0;
	}
	.rct-deck-chip {
		display: inline-block;
		padding: 1px 6px;
		font-size: 10px;
		font-weight: 500;
		border-radius: 3px;
		background: color-mix(in srgb, var(--proxy) 10%, var(--surface-2));
		color: var(--proxy);
		border: 1px solid color-mix(in srgb, var(--proxy) 25%, transparent);
		white-space: nowrap;
	}

	@media (max-width: 700px) {
		.inventory-toolbar {
			align-items: stretch;
		}
		.inventory-search {
			width: 100%;
			flex-basis: 100%;
		}
		.inventory-add-button {
			margin-left: 0;
			align-self: flex-start;
		}
		.inventory-segments {
			width: 100%;
			overflow-x: auto;
		}
		.inventory-segments button {
			flex: 1 0 auto;
		}
		.inventory-table thead {
			display: none;
		}
		.inventory-table tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 4px 12px;
			padding: 9px 2px;
			border-bottom: 1px solid var(--border);
		}
		.inventory-table tr.inventory-edit-row {
			display: block;
			padding: 0;
		}
		.inventory-edit-row > td {
			display: block;
		}
		.inventory-table td {
			padding: 0;
			border-bottom: 0;
		}
		.inventory-name {
			min-width: 0;
		}
		.inventory-condition {
			justify-self: end;
		}
		.inventory-assignment {
			grid-column: 1;
		}
		.inventory-home {
			grid-column: 2;
			grid-row: 2;
			justify-self: end;
		}
		.inventory-printing {
			grid-column: 1 / -1;
		}
		.inventory-actions {
			grid-column: 2;
			grid-row: 3;
			min-width: 0;
			justify-self: end;
		}
		.inventory-action-error {
			max-width: 100%;
		}
		.inventory-editor {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}
		.inventory-field--name,
		.inventory-field--notes,
		.inventory-edit-title,
		.inventory-form-error {
			grid-column: 1 / -1;
		}
	}
</style>
