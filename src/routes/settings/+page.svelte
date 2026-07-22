<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	import {
		getIgnoreBasics,
		getIgnoreMaybeboard,
		setIgnoreBasics,
		setIgnoreMaybeboard
	} from '$lib/app-settings';
	import {
		getBucketConfig,
		setBucketConfig,
		DEFAULT_BUCKET_CONFIG,
		COLOR_KEYS,
		BUCKET_TYPES,
		COLOR_LABELS,
		type BucketConfig,
		type ColorKey,
		type BucketTypeKey
	} from '$lib/bucket-config';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// ── Ignore Basics ─────────────────────────────────────────────────────
	let ignoreBasics = $state(false);

	// ── Ignore Maybeboard ────────────────────────────────────────────────
	let ignoreMaybeboard = $state(false);

	// ── Bucket config ─────────────────────────────────────────────────────
	let bucketConfig = $state<BucketConfig>(DEFAULT_BUCKET_CONFIG);
	let bucketOpen = $state(false);
	let tagRefreshing = $state(false);

	function formatTimestamp(timestamp: number): string {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(new Date(timestamp));
	}

	onMount(() => {
		ignoreBasics = getIgnoreBasics();
		ignoreMaybeboard = getIgnoreMaybeboard();
		bucketConfig = getBucketConfig();
	});

	// Preset options shown in each cell dropdown.
	// Label is display text; value is the stored range string.
	const BUCKET_PRESETS = [
		{ label: 'All (one pile)', value: 'all' },
		{ label: 'N/A (none)', value: 'n/a' },
		// standard 0-1 base
		{ label: '0–1 | 2+', value: '0-1,2+' },
		{ label: '0–1 | 2 | 3+', value: '0-1,2,3+' },
		{ label: '0–1 | 2 | 3 | 4+', value: '0-1,2,3,4+' },
		{ label: '0–1 | 2 | 3 | 4 | 5+', value: '0-1,2,3,4,5+' },
		{ label: '0–1 | 2 | 3 | 4 | 5 | 6+', value: '0-1,2,3,4,5,6+' },
		{ label: '0–1 | 2 | 3 | 4 | 5 | 6 | 7+', value: '0-1,2,3,4,5,6,7+' },
		// wide base
		{ label: '0–2 | 3+', value: '0-2,3+' },
		{ label: '0–2 | 3 | 4 | 5 | 6+', value: '0-2,3,4,5,6+' },
		{ label: '0–3 | 4+', value: '0-3,4+' },
		{ label: '0–4 | 5+', value: '0-4,5+' }
	];

	const PRESET_VALUES = new Set(BUCKET_PRESETS.map((p) => p.value));

	function updateCell(color: ColorKey, type: BucketTypeKey, value: string) {
		bucketConfig = {
			...bucketConfig,
			[color]: { ...bucketConfig[color], [type]: value.trim() || 'all' }
		};
		setBucketConfig(bucketConfig);
	}

	// Track which cells are in "custom text" mode (value not in presets)
	function isCustom(color: ColorKey, type: BucketTypeKey): boolean {
		const v = bucketConfig[color][type];
		return v !== 'with creatures' && !PRESET_VALUES.has(v);
	}

	function resetBuckets() {
		if (!confirm('Reset all bucket settings to defaults?')) return;
		bucketConfig = structuredClone(DEFAULT_BUCKET_CONFIG);
		setBucketConfig(bucketConfig);
	}
	function toggleIgnoreBasics() {
		ignoreBasics = !ignoreBasics;
		setIgnoreBasics(ignoreBasics);
	}

	// ── Backup / restore ─────────────────────────────────────────────────
	let restoreFile = $state<File | null>(null);
	let restoreState = $state<'idle' | 'confirming' | 'loading' | 'done' | 'error'>('idle');
	let restoreResult = $state<{ restored: Record<string, number> } | null>(null);
	let restoreError = $state('');

	function onFileChange(e: Event) {
		const f = (e.target as HTMLInputElement).files?.[0] ?? null;
		restoreFile = f;
		restoreState = f ? 'confirming' : 'idle';
		restoreResult = null;
		restoreError = '';
	}

	async function doRestore() {
		if (!restoreFile) return;
		restoreState = 'loading';
		try {
			const text = await restoreFile.text();
			const res = await fetch('/api/backup/restore', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: text
			});
			if (!res.ok) {
				const msg = await res.text();
				throw new Error(msg || `HTTP ${res.status}`);
			}
			restoreResult = await res.json();
			restoreState = 'done';
		} catch (err) {
			restoreError = err instanceof Error ? err.message : String(err);
			restoreState = 'error';
		}
	}

	function resetRestore() {
		restoreFile = null;
		restoreState = 'idle';
		restoreResult = null;
		restoreError = '';
		// clear the file input
		const input = document.getElementById('restore-file') as HTMLInputElement;
		if (input) input.value = '';
	}
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Settings</h1>
		<p class="page-subtitle">App preferences and data management</p>
	</div>
</div>

<!-- Deck issue preferences -->
<div class="card mb-2">
	<h2 style="font-size:15px;font-weight:700;margin-bottom:12px">Deck Issues</h2>
	<label style="display:flex;align-items:flex-start;gap:12px;cursor:pointer">
		<input
			type="checkbox"
			checked={ignoreBasics}
			onchange={toggleIgnoreBasics}
			style="width:16px;height:16px;margin-top:2px;flex-shrink:0;accent-color:var(--accent)"
		/>
		<div>
			<div style="font-size:13px;font-weight:600">Ignore basic lands in deck issues</div>
			<div style="font-size:12px;color:var(--text-muted);margin-top:2px">
				Hide basic lands (Plains, Island, Swamp, Mountain, Forest, Wastes) from unassigned counts,
				Missing, and Shortfalls. Basic lands in your decklists are still shown in the deck views.
			</div>
		</div>
	</label>
	<label style="display:flex;align-items:flex-start;gap:12px;cursor:pointer;margin-top:14px">
		<input
			type="checkbox"
			checked={ignoreMaybeboard}
			onchange={() => {
				ignoreMaybeboard = !ignoreMaybeboard;
				setIgnoreMaybeboard(ignoreMaybeboard);
			}}
			style="width:16px;height:16px;margin-top:2px;flex-shrink:0;accent-color:var(--accent)"
		/>
		<div>
			<div style="font-size:13px;font-weight:600">Ignore maybeboard cards in deck view</div>
			<div style="font-size:12px;color:var(--text-muted);margin-top:2px">
				Hide the Maybeboard section in the Manager view and exclude maybeboard cards from assignment
				counts and status badges.
			</div>
		</div>
	</label>
	<p style="font-size:11px;color:var(--text-muted);margin-top:10px;margin-bottom:0">
		These settings are saved in your browser. Changes take effect immediately on this device.
	</p>
</div>

<!-- Oracle tag cache -->
<div class="card mb-2">
	<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
		<div>
			<h2 style="font-size:15px;font-weight:700;margin-bottom:4px">Scryfall Oracle Tags</h2>
			<p class="text-muted text-sm" style="margin:0">
				Local tag data used by <code>otag:</code> and <code>oracle-tag:</code> collection searches.
			</p>
		</div>
		<form
			method="POST"
			action="?/refreshOracleTags"
			use:enhance={() => {
				tagRefreshing = true;
				return async ({ update }) => {
					await update();
					tagRefreshing = false;
				};
			}}
		>
			<button class="btn btn-primary" type="submit" disabled={tagRefreshing}>
				{tagRefreshing ? 'Refreshing...' : 'Refresh tags'}
			</button>
		</form>
	</div>

	{#if data.oracleTagMetadata}
		<div class="tag-meta">
			<div>
				<span>Last refreshed</span>
				<strong>{formatTimestamp(data.oracleTagMetadata.fetched_at)}</strong>
			</div>
			<div>
				<span>Tags</span>
				<strong>{data.oracleTagMetadata.tag_count.toLocaleString()}</strong>
			</div>
			<div>
				<span>Card relationships</span>
				<strong>{data.oracleTagMetadata.relation_count.toLocaleString()}</strong>
			</div>
		</div>
		<div class="tag-etag">
			<span>ETag</span>
			<code>{data.oracleTagMetadata.etag ?? 'Not provided'}</code>
		</div>
	{:else}
		<p class="text-muted text-sm" style="margin:14px 0 0">
			Oracle tags have not been imported yet. Refresh once to enable <code>otag:</code> searches.
		</p>
	{/if}

	{#if form?.oracleTagMessage}
		<div
			class:alert-success={form.oracleTagRefresh === 'ok' ||
				form.oracleTagRefresh === 'not_modified'}
			class:alert-error={form.oracleTagRefresh === 'error' ||
				form.oracleTagRefresh === 'already_running'}
			class="alert"
			style="margin-top:12px"
		>
			{form.oracleTagMessage}
		</div>
	{/if}
</div>

<!-- Card Storage Buckets -->
<div id="bucket-config" class="card mb-2">
	<button
		style="display:flex;align-items:center;justify-content:space-between;width:100%;background:none;border:none;cursor:pointer;padding:0;text-align:left"
		onclick={() => (bucketOpen = !bucketOpen)}
	>
		<div>
			<h2 style="font-size:15px;font-weight:700;margin-bottom:2px">Card Storage Buckets</h2>
			<p style="font-size:12px;color:var(--text-muted);margin:0">
				CMC ranges per type and color — used by the Pick List to sub-group cards
			</p>
		</div>
		<span style="font-size:13px;color:var(--text-muted);flex-shrink:0;margin-left:12px"
			>{bucketOpen ? '▲' : '▼'}</span
		>
	</button>
	<p style="font-size:12px;margin:8px 0 0">
		<a href="/help#storage">How storage locations and buckets work</a>
	</p>

	{#if bucketOpen}
		<div style="margin-top:16px;overflow-x:auto">
			<p style="font-size:11px;color:var(--text-muted);margin-bottom:10px">
				Each cell defines CMC buckets for that type + color combination.<br />
				Select from the dropdown. Choose <strong>Custom…</strong> to type a specific range (e.g.
				<code>0-1,2,3,4,5,6+</code>).
			</p>
			<table class="bucket-grid">
				<thead>
					<tr>
						<th>Type</th>
						{#each COLOR_KEYS as color}
							<th>{COLOR_LABELS[color]}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each BUCKET_TYPES as type}
						<tr>
							<td class="bucket-type-label">{type}</td>
							{#each COLOR_KEYS as color}
								<td>
									{#if isCustom(color, type)}
										<div style="display:flex;gap:3px;align-items:center">
											<input
												class="bucket-input"
												type="text"
												value={bucketConfig[color][type]}
												onblur={(e) =>
													updateCell(color, type, (e.target as HTMLInputElement).value)}
												onkeydown={(e) =>
													e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
											/>
											<button
												class="bucket-custom-clear"
												onclick={() => updateCell(color, type, 'all')}
												title="Switch to preset">✕</button
											>
										</div>
									{:else}
										<select
											class="bucket-select"
											value={bucketConfig[color][type]}
											onchange={(e) => {
												const v = (e.target as HTMLSelectElement).value;
												if (v !== '__custom__') updateCell(color, type, v);
												else updateCell(color, type, '0-1,2,3+');
											}}
										>
											{#if type === 'Planeswalker'}
												<option value="with creatures">With creatures</option>
											{/if}
											{#each BUCKET_PRESETS as p}
												<option value={p.value}>{p.label}</option>
											{/each}
											<option value="__custom__">Custom…</option>
										</select>
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
			<div style="margin-top:10px;display:flex;gap:8px;align-items:center">
				<button
					class="btn btn-sm"
					style="color:var(--danger);border-color:var(--danger)"
					onclick={resetBuckets}
				>
					Reset to defaults
				</button>
				<span style="font-size:11px;color:var(--text-muted)"
					>Changes save automatically on blur</span
				>
			</div>
		</div>
	{/if}
</div>

<!-- Download backup -->
<div class="card mb-2">
	<h2 style="font-size:15px;font-weight:700;margin-bottom:6px">⬇ Download Backup</h2>
	<p class="text-muted text-sm" style="margin-bottom:14px">
		Exports your collection, operational decks, assignments, printed proxies, shopping list, and
		orders as a single JSON file. Scryfall card data is not included — it lives in the local cache
		and can be re-synced.
	</p>
	<a href="/api/backup" download class="btn btn-primary" style="display:inline-block">
		Download backup
	</a>
</div>

<!-- Restore -->
<div class="card">
	<h2 style="font-size:15px;font-weight:700;margin-bottom:6px">⬆ Restore from Backup</h2>
	<p class="text-muted text-sm" style="margin-bottom:14px">
		Upload a backup JSON file to restore. <strong style="color:var(--error)"
			>This will permanently overwrite all current data.</strong
		>
	</p>

	{#if restoreState === 'idle' || restoreState === 'confirming'}
		<label style="display:inline-block;cursor:pointer" for="restore-file">
			<span class="btn">Choose backup file…</span>
		</label>
		<input
			id="restore-file"
			type="file"
			accept=".json,application/json"
			style="display:none"
			onchange={onFileChange}
		/>

		{#if restoreState === 'confirming' && restoreFile}
			<div
				style="margin-top:14px;padding:12px 16px;border:1px solid var(--error);border-radius:8px;background:color-mix(in srgb,var(--error) 8%,transparent)"
			>
				<p style="font-size:13px;margin-bottom:10px">
					<strong>⚠ Are you sure?</strong><br />
					Restoring <code>{restoreFile.name}</code> will <strong>delete all current data</strong> and
					replace it with the backup contents. This cannot be undone.
				</p>
				<div class="flex gap-2">
					<button class="btn btn-danger" onclick={doRestore}>Yes, restore now</button>
					<button class="btn" onclick={resetRestore}>Cancel</button>
				</div>
			</div>
		{/if}
	{/if}

	{#if restoreState === 'loading'}
		<div style="display:flex;align-items:center;gap:10px;color:var(--text-muted);font-size:13px">
			<span style="animation:spin 1s linear infinite;display:inline-block">⏳</span>
			Restoring… please don't close this page.
		</div>
	{/if}

	{#if restoreState === 'done' && restoreResult}
		<div class="alert alert-success" style="margin-top:8px">
			<strong>✓ Restore complete</strong>
			<ul style="margin:8px 0 0;padding-left:18px;font-size:13px">
				<li>{restoreResult.restored.collection} collection entries</li>
				<li>{restoreResult.restored.decks} decks</li>
				<li>{restoreResult.restored.deckCards} deck cards</li>
				<li>{restoreResult.restored.orders} orders</li>
				{#if restoreResult.restored.shoppingList != null}
					<li>{restoreResult.restored.shoppingList} shopping list items</li>
				{/if}
				{#if restoreResult.restored.proxyInventory != null}
					<li>{restoreResult.restored.proxyInventory} printed proxy inventory copies</li>
				{/if}
				<li>{restoreResult.restored.cardAssignments} card assignments</li>
				{#if restoreResult.restored.deckPendingRemovals != null}
					<li>{restoreResult.restored.deckPendingRemovals} pending removals</li>
					<li>{restoreResult.restored.deckPendingReturnAssignments} exact return assignments</li>
					<li>{restoreResult.restored.deckSyncAdditions} sync additions</li>
				{/if}
			</ul>
		</div>
		<button class="btn btn-sm" style="margin-top:10px" onclick={resetRestore}
			>Restore another file</button
		>
	{/if}

	{#if restoreState === 'error'}
		<div class="alert alert-error" style="margin-top:8px">
			<strong>✗ Restore failed</strong><br />
			<span style="font-size:12px;font-family:monospace">{restoreError}</span>
		</div>
		<button class="btn btn-sm" style="margin-top:10px" onclick={resetRestore}>Try again</button>
	{/if}
</div>

<style>
	.tag-meta {
		display: grid;
		grid-template-columns: repeat(3, minmax(120px, 1fr));
		gap: 16px;
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}
	.tag-meta div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.tag-meta span,
	.tag-etag span {
		font-size: 11px;
		color: var(--text-muted);
	}
	.tag-meta strong {
		font-size: 13px;
		font-weight: 600;
	}
	.tag-etag {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-top: 10px;
		min-width: 0;
	}
	.tag-etag code {
		overflow-wrap: anywhere;
		font-size: 11px;
	}
	@media (max-width: 640px) {
		.tag-meta {
			grid-template-columns: 1fr;
			gap: 10px;
		}
	}
	.bucket-grid {
		border-collapse: collapse;
		font-size: 12px;
		min-width: 700px;
	}
	.bucket-grid th {
		padding: 5px 8px;
		text-align: left;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
		white-space: nowrap;
		border-bottom: 1px solid var(--border);
	}
	.bucket-grid td {
		padding: 3px 4px;
		vertical-align: middle;
	}
	.bucket-type-label {
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		padding-right: 12px !important;
	}
	.bucket-select {
		width: 100%;
		min-width: 110px;
		padding: 3px 4px;
		font-size: 11px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
		box-sizing: border-box;
	}
	.bucket-select:focus {
		outline: none;
		border-color: var(--accent);
	}
	.bucket-grid tr:hover .bucket-select {
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
	}
	.bucket-input {
		flex: 1;
		min-width: 70px;
		padding: 3px 5px;
		font-size: 11px;
		font-family: 'SF Mono', 'Fira Code', monospace;
		border: 1px solid var(--accent);
		border-radius: 4px;
		background: var(--surface);
		color: var(--text);
		box-sizing: border-box;
	}
	.bucket-input:focus {
		outline: none;
	}
	.bucket-custom-clear {
		padding: 2px 5px;
		font-size: 10px;
		border: 1px solid var(--border);
		border-radius: 3px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		flex-shrink: 0;
	}
	.bucket-custom-clear:hover {
		color: var(--danger);
		border-color: var(--danger);
	}
</style>
