<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { PageData } from './$types';
	import { LOCATION_LABELS } from '$lib/types';
	import type { CardLocation } from '$lib/types';
	import { enhance } from '$app/forms';
	import CardImage from '$lib/components/CardImage.svelte';
	import {
		findActiveOracleTagToken,
		replaceActiveOracleTagToken
	} from '$lib/oracle-tag-autocomplete';

	let { data }: { data: PageData } = $props();

	let search = $state(untrack(() => data.search));
	let locationFilter = $state(untrack(() => data.locationFilter));
	let tagFilter = $state(untrack(() => data.tagFilter));
	let searchInput: HTMLInputElement;
	let oracleTagSuggestions = $state<string[]>([]);
	let oracleTagSuggestionIndex = $state(-1);
	let oracleTagRequest = 0;
	let oracleTagDebounce: ReturnType<typeof setTimeout> | null = null;

	function closeOracleTagSuggestions() {
		oracleTagSuggestions = [];
		oracleTagSuggestionIndex = -1;
		oracleTagRequest++;
	}

	function handleSearchInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		search = input.value;
		const active = findActiveOracleTagToken(search, input.selectionStart ?? search.length);
		if (!active || active.query.trim().length < 1) {
			if (oracleTagDebounce) clearTimeout(oracleTagDebounce);
			closeOracleTagSuggestions();
			return;
		}

		if (oracleTagDebounce) clearTimeout(oracleTagDebounce);
		const request = ++oracleTagRequest;
		oracleTagDebounce = setTimeout(async () => {
			try {
				const response = await fetch(
					`/api/oracle-tags/search?q=${encodeURIComponent(active.query)}&limit=8`
				);
				if (!response.ok || request !== oracleTagRequest) return;
				const result = (await response.json()) as { state: string; labels: string[] };
				if (request !== oracleTagRequest) return;
				oracleTagSuggestions = result.state === 'ready' ? result.labels : [];
				oracleTagSuggestionIndex = oracleTagSuggestions.length > 0 ? 0 : -1;
			} catch {
				if (request === oracleTagRequest) closeOracleTagSuggestions();
			}
		}, 150);
	}

	async function chooseOracleTag(label: string) {
		const cursor = searchInput.selectionStart ?? search.length;
		const active = findActiveOracleTagToken(search, cursor);
		if (!active) return;
		const replacement = replaceActiveOracleTagToken(search, active, label);
		search = replacement.value;
		closeOracleTagSuggestions();
		await tick();
		searchInput.focus();
		searchInput.setSelectionRange(replacement.cursor, replacement.cursor);
	}

	function handleSearchKeydown(event: KeyboardEvent) {
		if (oracleTagSuggestions.length > 0) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				oracleTagSuggestionIndex = (oracleTagSuggestionIndex + 1) % oracleTagSuggestions.length;
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				oracleTagSuggestionIndex =
					(oracleTagSuggestionIndex - 1 + oracleTagSuggestions.length) %
					oracleTagSuggestions.length;
				return;
			}
			if (event.key === 'Enter' && oracleTagSuggestionIndex >= 0) {
				event.preventDefault();
				void chooseOracleTag(oracleTagSuggestions[oracleTagSuggestionIndex]);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				closeOracleTagSuggestions();
				return;
			}
		}
		if (event.key === 'Enter') applyFilter();
	}

	function buildParams(p: number) {
		const params = new URLSearchParams();
		if (search) params.set('q', search);
		if (locationFilter) params.set('loc', locationFilter);
		if (tagFilter) params.set('tag', tagFilter);
		if (p > 1) params.set('page', String(p));
		return params.toString();
	}

	const exportHref = $derived.by(() => {
		const params = new URLSearchParams();
		if (search) params.set('q', search);
		if (locationFilter) params.set('loc', locationFilter);
		if (tagFilter) params.set('tag', tagFilter);
		const qs = params.toString();
		return '/api/collection/export' + (qs ? '?' + qs : '');
	});

	function applyFilter() {
		window.location.href = '/collection?' + buildParams(1);
	}

	const locationOptions: [string, string][] = [
		['', 'All Locations'],
		['binder', '$10+ Binder'],
		['holding_box', 'Holding Box'],
		['box_w', 'White Box'],
		['box_u', 'Blue Box'],
		['box_b', 'Black Box'],
		['box_r', 'Red Box'],
		['box_g', 'Green Box'],
		['box_multi', 'Multicolor Box'],
		['box_colorless', 'Colorless Box'],
		['box_land', 'Land Box'],
		['proxy_box', 'Proxy Deckbox']
	];
	const visibleLocationOptions = locationOptions;

	let expandedId = $state<number | null>(null);
	let actionError = $state<string | null>(null);
	let selectedHoldingIds = $state(new Set<number>());
	let bulkDestination = $state<CardLocation>('box_w');
	let bulkFileMessage = $state('');
	let bulkFileError = $state('');

	function toggleExpand(id: number) {
		expandedId = expandedId === id ? null : id;
		actionError = null;
	}

	function handleActionResult(result: {
		type: string;
		data?: { error?: string; success?: boolean };
	}) {
		if (result.type === 'failure') {
			actionError = result.data?.error ?? 'Something went wrong';
		} else if (result.type === 'success' && result.data?.success) {
			actionError = null;
		}
	}

	function parseTags(tagsJson: string | null): string[] {
		if (!tagsJson) return [];
		try {
			return JSON.parse(tagsJson);
		} catch {
			return [];
		}
	}

	const bulkFilingOptions = $derived(
		visibleLocationOptions.filter(
			([value]) => value !== '' && value !== 'holding_box' && value !== 'unknown'
		) as Array<[CardLocation, string]>
	);
	const visibleHoldingIds = $derived(
		data.entries.filter((entry) => entry.location === 'holding_box').map((entry) => entry.id)
	);
	const selectedHoldingIdList = $derived([...selectedHoldingIds].join(','));
	const allVisibleHoldingSelected = $derived(
		visibleHoldingIds.length > 0 && visibleHoldingIds.every((id) => selectedHoldingIds.has(id))
	);

	function toggleHoldingSelection(id: number) {
		const next = new Set(selectedHoldingIds);
		next.has(id) ? next.delete(id) : next.add(id);
		selectedHoldingIds = next;
		bulkFileError = '';
		bulkFileMessage = '';
	}

	function toggleAllVisibleHolding() {
		const next = new Set(selectedHoldingIds);
		if (allVisibleHoldingSelected) {
			for (const id of visibleHoldingIds) next.delete(id);
		} else {
			for (const id of visibleHoldingIds) next.add(id);
		}
		selectedHoldingIds = next;
		bulkFileError = '';
		bulkFileMessage = '';
	}

	// Subtitle
	let subtitle = $derived.by(() => {
		const total = data.total;
		if (total <= data.pageSize) return `${total.toLocaleString()} entries`;
		const start = (data.page - 1) * data.pageSize + 1;
		const end = Math.min(data.page * data.pageSize, total);
		return `Showing ${start}–${end} of ${total.toLocaleString()} entries`;
	});
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Collection</h1>
		<p class="page-subtitle">{subtitle}</p>
	</div>
	<div class="flex gap-2" style="align-items:center">
		{#if data.oldestPriceTs}
			{@const daysOld = Math.floor((Date.now() - data.oldestPriceTs) / 86400000)}
			<span
				class="text-sm"
				style="color: {daysOld > 7
					? 'var(--danger)'
					: daysOld > 3
						? 'var(--warning)'
						: 'var(--text-muted)'}"
			>
				Prices: {daysOld === 0 ? 'updated today' : `${daysOld}d old`}
			</span>
		{/if}
		<form method="POST" action="?/refreshPrices" use:enhance>
			<button type="submit" class="btn">↻ Refresh Prices</button>
		</form>
		<a href="/collection/add" class="btn btn-primary">+ Add Card</a>
		<a href="/collection/import" class="btn">+ Import CSV</a>
	</div>
</div>

<div class="filter-bar">
	<div class="search-autocomplete">
		<input
			bind:this={searchInput}
			type="text"
			placeholder="Search… (t:creature OR keyword:flying, !&quot;Sol Ring&quot;)"
			value={search}
			oninput={handleSearchInput}
			onkeydown={handleSearchKeydown}
			onblur={() => setTimeout(closeOracleTagSuggestions, 120)}
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={oracleTagSuggestions.length > 0}
			aria-controls="oracle-tag-suggestions"
			title="Scryfall syntax: AND, OR, parentheses, -negation, !&quot;Exact Name&quot;, /regex/, t:, o:, otag:/function:, is:/not:/has:, mv:, pow:/tou:/loy:, keyword:, produces:, artist:, flavor:, watermark:, date:/year:, set:/in:, st:/settype:, lang:, game:, finish:, frame:, layout:, border:, stamp:, cn:, rarity:, color:/id:, usd:, format:, sort:/order:"
		/>
		{#if oracleTagSuggestions.length > 0}
			<div id="oracle-tag-suggestions" class="search-suggestions" role="listbox">
				{#each oracleTagSuggestions as label, index}
					<button
						type="button"
						role="option"
						aria-selected={index === oracleTagSuggestionIndex}
						class:search-suggestion--active={index === oracleTagSuggestionIndex}
						onmousedown={(event) => event.preventDefault()}
						onclick={() => chooseOracleTag(label)}>{label}</button
					>
				{/each}
			</div>
		{/if}
	</div>
	<input
		type="text"
		placeholder="Filter by tag…"
		bind:value={tagFilter}
		onkeydown={(e) => e.key === 'Enter' && applyFilter()}
		style="width: 140px"
	/>
	<select bind:value={locationFilter} onchange={applyFilter}>
		{#each visibleLocationOptions as [val, label]}
			<option value={val}>{label}</option>
		{/each}
	</select>
	<button class="btn" onclick={applyFilter}>Search</button>
	{#if search || locationFilter || tagFilter}
		<a href="/collection" class="btn">Clear</a>
	{/if}
	<a href={exportHref} class="btn" download title="Export current search results as CSV"
		>↓ Export CSV</a
	>
</div>

{#if visibleHoldingIds.length > 0}
	<form
		method="POST"
		action="?/bulkFileHoldingBox"
		class="bulk-file-bar"
		use:enhance={() => {
			bulkFileError = '';
			bulkFileMessage = 'Filing...';
			return async ({ result, update }) => {
				if (result.type === 'failure') {
					const data = result.data as { error?: string } | undefined;
					bulkFileError = data?.error ?? 'Could not file selected cards';
					bulkFileMessage = '';
					return;
				}
				if (result.type === 'success') {
					const filed =
						(result.data as { filed?: number } | undefined)?.filed ?? selectedHoldingIds.size;
					bulkFileMessage = `Filed ${filed}`;
					selectedHoldingIds = new Set();
					await update();
				}
			};
		}}
	>
		<input type="hidden" name="ids" value={selectedHoldingIdList} />
		<button type="button" class="btn btn-sm" onclick={toggleAllVisibleHolding}>
			{allVisibleHoldingSelected ? 'Clear visible' : `Select ${visibleHoldingIds.length} visible`}
		</button>
		<span class="bulk-file-count">{selectedHoldingIds.size} selected</span>
		<label class="bulk-file-destination">
			<span>File to</span>
			<select name="location" bind:value={bulkDestination} disabled={selectedHoldingIds.size === 0}>
				{#each bulkFilingOptions as [val, label]}
					<option value={val}>{label}</option>
				{/each}
			</select>
		</label>
		<button type="submit" class="btn btn-primary btn-sm" disabled={selectedHoldingIds.size === 0}>
			File selected
		</button>
		{#if bulkFileMessage}<span class="bulk-file-message">{bulkFileMessage}</span>{/if}
		{#if bulkFileError}<span class="bulk-file-error">{bulkFileError}</span>{/if}
	</form>
{/if}

{#if data.searchError}
	<div
		class="empty-state"
		style="color:var(--danger);background:color-mix(in srgb,var(--danger) 6%,var(--surface));border:1px solid color-mix(in srgb,var(--danger) 20%,transparent);border-radius:6px;padding:12px 16px"
	>
		<strong>Search error:</strong>
		{data.searchError}
	</div>
{:else if data.entries.length === 0}
	<div class="empty-state">
		{#if data.search || data.locationFilter || data.tagFilter}
			<p>No cards match your filters.</p>
		{:else}
			<p>No collection imported. <a href="/collection/import">Import a collection CSV</a>.</p>
		{/if}
	</div>
{:else}
	<table class="data-table">
		<thead>
			<tr>
				<th class="bulk-select-col"></th>
				<th>Card</th>
				<th>Set / #</th>
				<th>Cond</th>
				<th>Qty</th>
				<th>Assigned</th>
				<th>Avail</th>
				<th>Price</th>
				<th>Location</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each data.entries as entry}
				{@const entryTags = parseTags(entry.tags)}
				<tr>
					<td class="bulk-select-col">
						{#if entry.location === 'holding_box'}
							<input
								type="checkbox"
								class="bulk-file-checkbox"
								checked={selectedHoldingIds.has(entry.id)}
								onchange={() => toggleHoldingSelection(entry.id)}
								aria-label="Select {entry.name} for filing"
							/>
						{/if}
					</td>
					<td>
						<CardImage
							imageUri={entry.imageUri ?? null}
							backImageUri={entry.backImageUri ?? null}
							name={entry.name}
						>
							<a href="/cards/{encodeURIComponent(entry.name)}" class="picklist-card-name card-link"
								>{entry.name}</a
							>
						</CardImage>
						{#if entry.foil}<span
								class="badge"
								style="background:color-mix(in srgb,var(--gold) 10%,var(--surface));color:var(--gold);border-color:color-mix(in srgb,var(--gold) 28%,transparent);margin-left:4px"
								>Foil</span
							>{/if}
						{#if entryTags.length > 0}
							{#each entryTags as tag}
								<span
									class="badge"
									style="background:var(--surface-2);color:var(--text-muted);font-size:10px;margin-left:3px"
									>{tag}</span
								>
							{/each}
						{/if}
					</td>
					<td class="mono text-muted text-sm"
						>{entry.setCode.toUpperCase()} #{entry.collectorNumber}</td
					>
					<td>{entry.condition}</td>
					<td style="font-weight:600">{entry.quantity}</td>
					<td style="color: var(--warning)">{entry.assigned}</td>
					<td style="color: {entry.available > 0 ? 'var(--success)' : 'var(--danger)'}"
						>{entry.available}</td
					>
					<td class="text-sm">
						{#if entry.foil && entry.priceUsdFoil}
							<span style="color: var(--gold)">${entry.priceUsdFoil.toFixed(2)}</span>
						{:else if entry.priceUsd}
							${entry.priceUsd.toFixed(2)}
						{:else}
							<span class="text-muted">—</span>
						{/if}
					</td>
					<td>
						<span class="loc-chip loc-{entry.location}">
							{LOCATION_LABELS[entry.location as CardLocation] ?? entry.location}
						</span>
					</td>
					<td>
						<button class="btn btn-sm" onclick={() => toggleExpand(entry.id)}>
							{expandedId === entry.id ? '▲' : '▼'}
						</button>
					</td>
				</tr>
				{#if expandedId === entry.id}
					<tr>
						<td colspan="10" style="background: var(--bg); padding: 12px 16px;">
							{#if actionError}
								<div
									style="color:var(--danger);font-size:12px;margin-bottom:8px;padding:6px 10px;background:color-mix(in srgb,var(--danger) 8%,var(--surface));border-radius:4px;border:1px solid color-mix(in srgb,var(--danger) 20%,transparent)"
								>
									{actionError}
								</div>
							{/if}

							<!-- Quantity -->
							<form
								method="POST"
								action="?/updateQuantity"
								use:enhance={() => {
									actionError = null;
									return ({ result }) => handleActionResult(result as any);
								}}
								style="display:flex;gap:8px;align-items:center;margin-bottom:10px"
							>
								<input type="hidden" name="id" value={entry.id} />
								<label for="qty-{entry.id}" style="margin:0;white-space:nowrap">Quantity:</label>
								<input
									type="number"
									id="qty-{entry.id}"
									name="quantity"
									min="1"
									value={entry.quantity}
									style="width:70px"
								/>
								<button type="submit" class="btn btn-primary btn-sm">Save</button>
							</form>

							<!-- Printing -->
							<form
								method="POST"
								action="?/updatePrinting"
								use:enhance={() => {
									actionError = null;
									return ({ result, update }) => {
										handleActionResult(result as any);
										if ((result as any).type === 'success') update();
									};
								}}
								style="display:flex;gap:8px;align-items:center;margin-bottom:10px"
							>
								<input type="hidden" name="id" value={entry.id} />
								<label for="printing-set-{entry.id}" style="margin:0;white-space:nowrap"
									>Printing:</label
								>
								<input
									id="printing-set-{entry.id}"
									type="text"
									name="setCode"
									placeholder="set"
									value={entry.setCode}
									style="width:60px;text-transform:lowercase"
								/>
								<span style="color:var(--text-muted)">#</span>
								<input
									type="text"
									name="collectorNumber"
									placeholder="number"
									value={entry.collectorNumber}
									style="width:60px"
								/>
								<button type="submit" class="btn btn-primary btn-sm">Save</button>
							</form>

							<!-- Location override -->
							<form
								method="POST"
								action="?/setLocationOverride"
								use:enhance
								style="display:flex;gap:8px;align-items:center;margin-bottom:10px"
							>
								<input type="hidden" name="id" value={entry.id} />
								<label for="override-{entry.id}" style="margin:0;white-space:nowrap"
									>Location:</label
								>
								<select
									name="override"
									id="override-{entry.id}"
									style="width:auto"
									value={entry.locationOverride ?? ''}
								>
									<option value="">Auto-detect</option>
									{#each visibleLocationOptions.slice(1) as [val, label]}
										<option value={val}>{label}</option>
									{/each}
								</select>
								<button type="submit" class="btn btn-primary btn-sm">Save</button>
							</form>

							<!-- Tags edit -->
							<form
								method="POST"
								action="?/setTags"
								use:enhance
								style="display:flex;gap:8px;align-items:center;margin-bottom:10px"
							>
								<input type="hidden" name="id" value={entry.id} />
								<label for="tags-{entry.id}" style="margin:0;white-space:nowrap">Tags:</label>
								<input
									type="text"
									id="tags-{entry.id}"
									name="tags"
									value={entryTags.join(', ')}
									placeholder="comma-separated tags"
									style="width:260px"
								/>
								<button type="submit" class="btn btn-primary btn-sm">Save</button>
							</form>

							{#if entry.typeLine}
								<div class="text-sm text-muted" style="margin-bottom:8px">
									Type: {entry.typeLine} · CMC: {entry.cmc ?? '—'}
								</div>
							{/if}

							<div class="flex gap-2" style="align-items:center">
								<a
									href="/orders?card={encodeURIComponent(
										entry.name
									)}&set={entry.setCode}&cn={entry.collectorNumber}"
									class="btn btn-sm"
									style="font-size:11px">Order more</a
								>
								<a href="/collection/add" class="btn btn-sm" style="font-size:11px">+ Add copy</a>
								<form
									method="POST"
									action="?/deleteEntry"
									use:enhance={() => {
										actionError = null;
										return ({ result, update }) => {
											handleActionResult(result as any);
											if ((result as any).type === 'success') update();
										};
									}}
									style="margin-left:auto"
								>
									<input type="hidden" name="id" value={entry.id} />
									<button
										type="submit"
										class="btn btn-sm"
										style="color:var(--danger);border-color:color-mix(in srgb,var(--danger) 30%,transparent)"
										onclick={(e) => {
											if (!confirm(`Delete this copy of ${entry.name}?`)) e.preventDefault();
										}}>Delete</button
									>
								</form>
							</div>
						</td>
					</tr>
				{/if}
			{/each}
		</tbody>
	</table>

	<!-- Pagination -->
	{#if data.total > data.pageSize}
		<div
			style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border);margin-top:2px"
		>
			<span class="text-sm text-muted"
				>Showing {(data.page - 1) * data.pageSize + 1}–{Math.min(
					data.page * data.pageSize,
					data.total
				)} of {data.total.toLocaleString()}</span
			>
			<div style="margin-left:auto;display:flex;gap:6px">
				{#if data.page > 1}
					<a href="/collection?{buildParams(data.page - 1)}" class="btn btn-sm">← Prev</a>
				{/if}
				{#if data.page * data.pageSize < data.total}
					<a href="/collection?{buildParams(data.page + 1)}" class="btn btn-sm">Next →</a>
				{/if}
			</div>
		</div>
	{/if}
{/if}

<style>
	.bulk-file-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin: 0 0 10px;
		padding: 7px 8px;
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--accent) 3%, var(--surface));
	}
	.bulk-file-count,
	.bulk-file-message,
	.bulk-file-error {
		font-size: 12px;
		font-weight: 600;
	}
	.bulk-file-count {
		color: var(--text-muted);
	}
	.bulk-file-message {
		color: var(--success);
	}
	.bulk-file-error {
		color: var(--danger);
	}
	.bulk-file-destination {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		color: var(--text-muted);
		font-size: 11px;
		font-weight: 600;
	}
	.bulk-file-destination select {
		width: auto;
		min-width: 150px;
		height: 28px;
		font-size: 12px;
	}
	.bulk-select-col {
		width: 30px;
		text-align: center;
	}
	.bulk-file-checkbox {
		width: 14px;
		height: 14px;
		accent-color: var(--accent);
		cursor: pointer;
	}
	.search-autocomplete {
		position: relative;
		width: 260px;
		flex: 0 0 260px;
	}
	.search-autocomplete > input {
		width: 100%;
	}
	.search-suggestions {
		position: absolute;
		z-index: 30;
		top: calc(100% + 3px);
		left: 0;
		right: 0;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface);
		box-shadow: var(--shadow-md);
	}
	.search-suggestions button {
		display: block;
		width: 100%;
		min-height: 30px;
		padding: 5px 9px;
		border: 0;
		border-top: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}
	.search-suggestions button:first-child {
		border-top: 0;
	}
	.search-suggestions button:hover,
	.search-suggestion--active {
		background: color-mix(in srgb, var(--accent) 10%, var(--surface));
	}
	@media (max-width: 640px) {
		.search-autocomplete {
			width: 100%;
			flex-basis: 100%;
		}
	}
</style>
