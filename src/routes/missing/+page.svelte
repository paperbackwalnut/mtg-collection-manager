<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageData } from './$types';
	import type { MissingCard } from './+page.server';
	import { getIgnoreBasics } from '$lib/app-settings';
	import { isBasicLand } from '$lib/basics';
	import { addItem, getItems } from '$lib/shopping-list';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	let { data }: { data: PageData } = $props();

	// ── Settings ──────────────────────────────────────────────────────────
	let ignoreBasics = $state(false);
	let listCardNames = $state(new Set<string>());

	async function refreshList() {
		const items = await getItems();
		listCardNames = new Set(items.map((i) => i.cardName));
	}

	onMount(() => {
		ignoreBasics = getIgnoreBasics();
		refreshList();
	});

	// ── Sorting ───────────────────────────────────────────────────────────
	type SortCol = 'name' | 'deckCount' | 'needed' | 'price' | 'cost';
	let sortCol = $state<SortCol>('needed');
	let sortDir = $state<'asc' | 'desc'>('desc');

	function setSort(col: SortCol) {
		if (sortCol === col) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortCol = col;
			sortDir = col === 'name' ? 'asc' : 'desc';
		}
	}
	function sortIcon(col: SortCol) {
		if (sortCol !== col) return '⇅';
		return sortDir === 'asc' ? '▲' : '▼';
	}

	// ── Deck filter — URL-persisted so refresh keeps selection ───────────
	function parseDeckParam(): Set<number> {
		const param = page.url.searchParams.get('decks');
		if (!param) return new Set();
		return new Set(
			param
				.split(',')
				.map(Number)
				.filter((n) => !isNaN(n) && n > 0)
		);
	}

	let selectedDeckIds = $state<Set<number>>(parseDeckParam());
	let deckDropdownOpen = $state(false);

	$effect(() => {
		const params = new URLSearchParams(page.url.search);
		if (selectedDeckIds.size > 0) {
			params.set('decks', [...selectedDeckIds].join(','));
		} else {
			params.delete('decks');
		}
		const query = params.toString();
		const newUrl = query ? `${page.url.pathname}?${query}` : page.url.pathname;
		if (newUrl !== page.url.pathname + page.url.search) {
			goto(newUrl, { replaceState: true, keepFocus: true, noScroll: true });
		}
	});

	const deckOptions = $derived.by(() => {
		const seen = new Map<number, string>();
		for (const card of data.cards) {
			for (const deck of card.decks) {
				if (!seen.has(deck.id)) seen.set(deck.id, deck.name);
			}
		}
		return [...seen.entries()]
			.map(([id, name]) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name));
	});

	function toggleDeck(id: number) {
		const next = new Set(selectedDeckIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedDeckIds = next;
	}
	function clearDecks() {
		selectedDeckIds = new Set();
		deckDropdownOpen = false;
	}
	function onDeckDropdownKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') deckDropdownOpen = false;
	}

	// ── Search + filter ───────────────────────────────────────────────────
	let search = $state('');

	const displayCards = $derived.by(() => {
		let cards = data.cards as MissingCard[];
		if (ignoreBasics) cards = cards.filter((c) => !isBasicLand(c.cardName));
		if (selectedDeckIds.size > 0)
			cards = cards.filter((c) => c.decks.some((d) => selectedDeckIds.has(d.id)));
		if (search.trim()) {
			const q = search.trim().toLowerCase();
			cards = cards.filter((c) => c.cardName.toLowerCase().includes(q));
		}
		return [...cards].sort((a, b) => {
			let cmp = 0;
			switch (sortCol) {
				case 'name':
					cmp = a.cardName.localeCompare(b.cardName);
					break;
				case 'deckCount':
					cmp = a.deckCount - b.deckCount;
					break;
				case 'needed':
					cmp = a.totalDeckQty - b.totalDeckQty;
					break;
				case 'price':
					cmp = (a.priceUsd ?? -1) - (b.priceUsd ?? -1);
					break;
				case 'cost':
					cmp = (a.estimatedCost ?? -1) - (b.estimatedCost ?? -1);
					break;
			}
			return sortDir === 'asc' ? cmp : -cmp;
		});
	});

	// ── Summary ───────────────────────────────────────────────────────────
	const totalNeeded = $derived(displayCards.reduce((s, c) => s + c.totalDeckQty, 0));
	const totalCost = $derived(displayCards.reduce((s, c) => s + (c.estimatedCost ?? 0), 0));

	// ── Shopping List actions ─────────────────────────────────────────────
	let addFeedback = $state<Record<string, string>>({});
	let bulkFeedback = $state('');
	let bulkBusy = $state(false);

	async function addToList(cardName: string, qty: number) {
		await addItem(cardName, qty, 'missing');
		await refreshList();
		addFeedback = { ...addFeedback, [cardName]: '✓' };
		setTimeout(() => {
			const { [cardName]: _, ...rest } = addFeedback;
			addFeedback = rest;
		}, 1500);
	}

	async function addAllVisible() {
		if (bulkBusy) return;
		bulkBusy = true;
		await Promise.all(displayCards.map((c) => addItem(c.cardName, c.totalDeckQty, 'missing')));
		await refreshList();
		bulkBusy = false;
		bulkFeedback = `Added ${displayCards.length} card${displayCards.length !== 1 ? 's' : ''} to Shopping List`;
		setTimeout(() => (bulkFeedback = ''), 3000);
	}

	function fmt(n: number | null) {
		if (n == null) return '—';
		return `$${n.toFixed(2)}`;
	}
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Missing Cards</h1>
		<p class="page-subtitle">
			{#if displayCards.length > 0}
				<span style="color:var(--danger);font-weight:600"
					>{displayCards.length} card{displayCards.length !== 1 ? 's' : ''}</span
				>
				with zero owned copies · {totalNeeded} total copies needed
				{#if totalCost > 0}· est. low <strong>${totalCost.toFixed(2)}</strong> to fill{/if}
			{:else if ignoreBasics && data.cards.length > 0}
				All missing cards are basic lands (currently hidden)
			{:else}
				All cards in your decklists exist in your collection
			{/if}
		</p>
	</div>
	<a href="/shopping-list" class="btn btn-sm">Shopping List →</a>
</div>

{#if data.cards.length === 0}
	<div class="empty-state">
		<p>No missing cards — every card in your decklists exists in your collection.</p>
		<p class="text-muted text-sm" style="margin-top:6px">
			Note: this does not mean all copies are assigned — check <a href="/shortfalls">Shortfalls</a> for
			quantity gaps.
		</p>
		<a href="/decks" class="btn" style="margin-top:12px">View decks →</a>
	</div>
{:else}
	<div class="filter-bar">
		<input
			type="search"
			placeholder="Search cards…"
			bind:value={search}
			style="max-width:260px;flex:0 1 260px"
		/>
		{#if deckOptions.length > 0}
			{#if deckDropdownOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					style="position:fixed;inset:0;z-index:49"
					onclick={() => (deckDropdownOpen = false)}
					onkeydown={onDeckDropdownKeydown}
				></div>
			{/if}
			<div class="deck-filter" role="none">
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div
					class="deck-trigger act-chip"
					class:deck-trigger-active={selectedDeckIds.size > 0}
					role="button"
					tabindex="0"
					aria-expanded={deckDropdownOpen}
					onclick={() => (deckDropdownOpen = !deckDropdownOpen)}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							deckDropdownOpen = !deckDropdownOpen;
						}
						onDeckDropdownKeydown(e);
					}}
				>
					{#if selectedDeckIds.size === 0}Decks ▾{:else}{selectedDeckIds.size} deck{selectedDeckIds.size !==
						1
							? 's'
							: ''} ▾{/if}
				</div>
				{#if deckDropdownOpen}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="deck-dropdown" onkeydown={onDeckDropdownKeydown}>
						{#each deckOptions as deck}
							<label class="deck-option">
								<input
									type="checkbox"
									checked={selectedDeckIds.has(deck.id)}
									onchange={() => toggleDeck(deck.id)}
								/>
								<span>{deck.name}</span>
							</label>
						{/each}
						{#if selectedDeckIds.size > 0}
							<div class="deck-dropdown-footer">
								<button
									class="act-chip"
									style="font-size:11px;color:var(--danger);border-color:color-mix(in srgb,var(--danger) 35%,transparent)"
									onclick={clearDecks}>Clear</button
								>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
		{#if ignoreBasics}
			<span class="badge badge-ordered" style="font-size:11px">Basics hidden</span>
		{/if}
		<span class="text-muted text-sm" style="margin-left:auto">
			{displayCards.length} of {data.cards.length} shown
		</span>
	</div>

	{#if selectedDeckIds.size > 0}
		<div class="deck-chips">
			{#each deckOptions.filter((d) => selectedDeckIds.has(d.id)) as deck}
				<button
					class="act-chip deck-chip-active"
					onclick={() => toggleDeck(deck.id)}
					title="Remove filter">{deck.name} ×</button
				>
			{/each}
			<button class="act-chip" style="font-size:11px;color:var(--text-muted)" onclick={clearDecks}
				>Clear all</button
			>
		</div>
	{/if}

	<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
		<button
			class="btn btn-sm"
			onclick={addAllVisible}
			disabled={bulkBusy || displayCards.length === 0}
		>
			{bulkBusy ? 'Adding…' : `Add visible to Shopping List (${displayCards.length})`}
		</button>
		{#if bulkFeedback}
			<span style="font-size:12px;color:var(--success);font-weight:600">{bulkFeedback}</span>
		{/if}
	</div>

	<table class="data-table">
		<thead>
			<tr>
				<th class="sortable" onclick={() => setSort('name')} style="width:28%;cursor:pointer"
					>Card {sortIcon('name')}</th
				>
				<th title="Copies you own">Own</th>
				<th
					class="sortable"
					onclick={() => setSort('deckCount')}
					title="Number of decks using this card"
					style="cursor:pointer">Decks {sortIcon('deckCount')}</th
				>
				<th
					class="sortable"
					onclick={() => setSort('needed')}
					title="Total copies needed across all decks"
					style="cursor:pointer;color:var(--danger)">Needed {sortIcon('needed')}</th
				>
				<th
					class="sortable"
					onclick={() => setSort('price')}
					title="Lowest Scryfall USD price (estimate)"
					style="cursor:pointer">Low Price {sortIcon('price')}</th
				>
				<th
					class="sortable"
					onclick={() => setSort('cost')}
					title="Est. Cost = lowest price × needed"
					style="cursor:pointer">Est. Cost {sortIcon('cost')}</th
				>
				<th>Used in</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each displayCards as card}
				<tr>
					<td>
						<a
							href="/cards/{encodeURIComponent(card.cardName)}"
							class="card-link"
							style="font-weight:600">{card.cardName}</a
						>
					</td>
					<td style="font-weight:700;font-size:13px;color:var(--danger)">0</td>
					<td style="font-size:13px;color:var(--text-muted)">{card.deckCount}</td>
					<td>
						<span style="font-weight:700;font-size:13px;color:var(--danger)"
							>−{card.totalDeckQty}</span
						>
					</td>
					<td style="font-size:12px;color:var(--text-muted)">{fmt(card.priceUsd)}</td>
					<td
						style="font-size:12px;font-weight:{card.estimatedCost
							? '600'
							: '400'};color:{card.estimatedCost ? 'var(--text)' : 'var(--text-muted)'}"
					>
						{fmt(card.estimatedCost)}
					</td>
					<td>
						<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;max-width:220px">
							{#each card.decks as deck}
								<a
									href="/decks/{deck.id}"
									style="font-size:11px;color:var(--text-muted);text-decoration:none;white-space:nowrap"
									>{deck.name}{deck.deckQty > 1 ? ` ×${deck.deckQty}` : ''}</a
								>
								{#if deck !== card.decks[card.decks.length - 1]}
									<span style="color:var(--border);font-size:10px">·</span>
								{/if}
							{/each}
						</div>
					</td>
					<td style="white-space:nowrap">
						{#if addFeedback[card.cardName]}
							<span style="font-size:11px;color:var(--success);font-weight:600"
								>{addFeedback[card.cardName]}</span
							>
						{:else if listCardNames.has(card.cardName)}
							<span
								class="act-chip"
								style="font-size:11px;color:var(--success);border-color:color-mix(in srgb,var(--success) 40%,transparent)"
								>On list ✓</span
							>
						{:else}
							<button
								class="act-chip"
								style="font-size:11px"
								onclick={() => addToList(card.cardName, card.totalDeckQty)}
								title="Add to Shopping List">+ List</button
							>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<style>
	th.sortable:hover {
		color: var(--text);
		background: color-mix(in srgb, var(--accent) 6%, var(--surface-2));
	}

	.deck-filter {
		position: relative;
		flex: none;
	}
	.deck-trigger {
		font-size: 12px;
		user-select: none;
	}
	.deck-trigger-active {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 50%, transparent);
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}
	.deck-dropdown {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 50;
		min-width: 200px;
		max-height: 280px;
		overflow-y: auto;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		box-shadow: 0 4px 16px color-mix(in srgb, var(--text) 12%, transparent);
		padding: 4px 0;
	}
	.deck-option {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 12px;
		font-size: 12px;
		cursor: pointer;
		white-space: nowrap;
		color: var(--text);
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
	.deck-dropdown-footer {
		border-top: 1px solid var(--border);
		padding: 6px 10px 4px;
		margin-top: 2px;
	}

	.deck-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 10px;
		margin-top: -6px;
	}
	.deck-chip-active {
		font-size: 11px;
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}
	.deck-chip-active:hover {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		border-color: var(--accent);
	}
</style>
