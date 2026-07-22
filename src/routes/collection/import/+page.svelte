<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let loading = $state(false);
	let applying = $state(false);
	let enriching = $state(false);
	let mode = $state<'merge' | 'sync' | 'replace'>('merge');
	let destination = $state<'auto' | 'holding_box'>('auto');
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Import Collection</h1>
		<p class="page-subtitle">Import a Moxfield CSV or a collection CSV exported by this app</p>
	</div>
	<a href="/collection" class="btn">← Back</a>
</div>

{#if form?.success}
	{#if form.mode === 'sync' || form.mode === 'merge'}
		<div class="alert alert-success">
			✓ {form.mode === 'sync' ? 'Synchronized' : 'Merged'} —
			{#if form.imported > 0}<strong>{form.imported} added</strong>{form.updated > 0 ||
				form.removed > 0 ||
				form.unchanged > 0
					? ', '
					: ''}{/if}{#if form.updated > 0}<strong>{form.updated} updated</strong>{form.removed >
					0 || form.unchanged > 0
					? ', '
					: ''}{/if}{#if form.removed > 0}<strong>{form.removed} removed</strong>{form.unchanged > 0
					? ', '
					: ''}{/if}{#if form.kept > 0}<span class="text-muted">
					({form.kept} kept — still in decks)</span
				>{/if}{#if form.unchanged > 0}<span style="color:var(--text-muted)"
					>{form.unchanged} unchanged</span
				>{/if}{#if form.imported === 0 && form.updated === 0 && form.removed === 0}already up to
				date{/if}
			{#if form.scryfallMatched > 0}
				· {form.scryfallMatched} newly enriched{/if}{#if form.scryfallNotFound > 0}
				· {form.scryfallNotFound} not found in Scryfall{/if}
		</div>
	{:else}
		<div class="alert alert-success">
			✓ Replaced collection — <strong>{form.imported}</strong> cards imported ({form.scryfallMatched}
			enriched with Scryfall data
			{form.scryfallNotFound > 0 ? `, ${form.scryfallNotFound} not found` : ''}).
		</div>
	{/if}
	{#if form.scryfallMatched === 0 && form.imported > 0}
		<div class="alert alert-error">
			Scryfall enrichment failed during import — cards were saved but have no type, price, or
			location data. Use the <strong>Enrich cards</strong> button below to fetch Scryfall data without
			re-uploading.
		</div>
	{/if}
{/if}

{#if form?.enrichSuccess}
	<div class="alert alert-success">
		✓ Enriched <strong>{form.enriched}</strong> cards with Scryfall data
		{form.enrichNotFound > 0 ? `(${form.enrichNotFound} not found in bulk data)` : ''}.
	</div>
{/if}

{#if form?.error}
	<div class="alert alert-error">✗ {form.error}</div>
{/if}

<div class="card mb-2">
	<h2 style="margin: 0 0 12px; font-size: 15px">Supported CSV files</h2>
	<ol style="color: var(--text-muted); font-size: 13px; padding-left: 20px; margin: 0 0 20px">
		<li><strong>Moxfield collection export:</strong> Collection → Export → CSV</li>
		<li><strong>This app's collection export:</strong> Collection → Export CSV</li>
		<li>
			Upload the complete export below; filtered app exports contain only the visible search result.
		</li>
	</ol>

	<hr class="divider" />

	<div class="alert alert-info" style="margin-bottom: 16px">
		<strong>Note:</strong> Cards marked as <strong>Proxy</strong> in Moxfield are treated as proxy copies
		and placed in your Proxy Box.
	</div>

	<div
		class="alert"
		style="background:var(--surface-2);border:1px solid var(--border);margin-bottom:16px;font-size:13px"
	>
		<strong>Fast imports:</strong> Upload the
		<a href="https://scryfall.com/docs/api/bulk-data" target="_blank" rel="noopener"
			>Scryfall bulk data</a
		>
		file once via <a href="/collection/scryfall">Scryfall Cache</a> to load card metadata locally. After
		that, every import is instant — no downloads, no rate limiting, works on any machine.
	</div>

	<form
		method="POST"
		action="?/preview"
		enctype="multipart/form-data"
		use:enhance={({ submitter }) => {
			const isApply = submitter?.getAttribute('formaction')?.includes('/import') ?? false;
			if (isApply) applying = true;
			else loading = true;
			return async ({ update }) => {
				await update({ reset: isApply });
				loading = false;
				applying = false;
			};
		}}
	>
		<div class="form-group">
			<label for="csv">Collection CSV</label>
			<input type="file" id="csv" name="csv" accept=".csv,text/csv" required />
			<div class="form-hint">
				Required concepts: quantity, name, set code, and collector number. Moxfield and this app's
				export headers are detected automatically.
			</div>
		</div>

		<div class="form-group">
			<label for="import-destination">New card destination</label>
			<select id="import-destination" name="destination" bind:value={destination}>
				<option value="auto">Auto file by card</option>
				<option value="holding_box">Holding Box</option>
			</select>
			<div class="form-hint">
				Merge and synchronize apply this only to newly imported cards. Existing manual locations are
				preserved. Full replace applies it to every non-proxy card. Moxfield proxies still go to
				Proxy Box.
			</div>
		</div>

		<fieldset class="form-group" style="border:0;padding:0">
			<legend style="font-weight:600;display:block;margin-bottom:8px">Import mode</legend>
			<div style="display:flex;flex-direction:column;gap:10px">
				<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
					<input
						type="radio"
						name="mode"
						value="merge"
						bind:group={mode}
						style="margin-top:3px;flex-shrink:0"
					/>
					<div>
						<div style="font-weight:500">
							Merge/update <span style="color:var(--text-muted);font-weight:400;font-size:13px"
								>(recommended)</span
							>
						</div>
						<div style="font-size:12px;color:var(--text-muted);margin-top:2px">
							Adds new cards and updates matching quantities and prices. Never removes collection
							entries.
						</div>
					</div>
				</label>
				<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
					<input
						type="radio"
						name="mode"
						value="sync"
						bind:group={mode}
						style="margin-top:3px;flex-shrink:0"
					/>
					<div>
						<div style="font-weight:500">
							Synchronize <span style="color:var(--warning);font-weight:400;font-size:13px"
								>(can remove cards)</span
							>
						</div>
						<div style="font-size:12px;color:var(--text-muted);margin-top:2px">
							Matches the file exactly. Entries missing from the file are removed unless assigned to
							a deck.
						</div>
					</div>
				</label>
				<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
					<input
						type="radio"
						name="mode"
						value="replace"
						bind:group={mode}
						style="margin-top:3px;flex-shrink:0"
					/>
					<div>
						<div style="font-weight:500">
							Full replace <span style="color:var(--error);font-weight:400;font-size:13px"
								>(destructive)</span
							>
						</div>
						<div style="font-size:12px;color:var(--text-muted);margin-top:2px">
							Wipes your entire collection and imports fresh. Loses all location overrides and
							unlinks deck assignments.
						</div>
					</div>
				</label>
			</div>
		</fieldset>

		<button type="submit" class="btn btn-primary" disabled={loading || applying}>
			{loading ? 'Analyzing…' : 'Preview changes'}
		</button>

		{#if loading}
			<div class="alert alert-info" style="margin-top: 12px">
				<strong>Working…</strong> Reading the file and comparing it with your collection. No data is changing
				yet.
			</div>
		{/if}

		{#if form?.preview && form.previewMode === mode && form.previewDestination === destination}
			<input type="hidden" name="previewHash" value={form.previewHash} />
			<div class="alert {mode === 'merge' ? 'alert-info' : 'alert-error'}" style="margin-top:16px">
				<strong>Preview: {form.previewFileName}</strong>
				<div style="margin-top:6px;font-size:13px">
					{form.total} valid rows · {form.added} new · {form.updated} updated · {form.unchanged} unchanged
					{#if form.proxyRows > 0}
						· {form.proxyRows} proxy rows{/if}
				</div>
				{#if mode === 'sync'}
					<div style="margin-top:6px">
						<strong>{form.removeCandidates} entries will be removed.</strong>
						{#if form.protectedRemovals > 0}{form.protectedRemovals} assigned entries will be kept.{/if}
					</div>
				{:else if mode === 'replace'}
					<div style="margin-top:6px">
						<strong
							>All {form.currentCount} current entries will be replaced and physical assignments unlinked.</strong
						>
					</div>
				{:else}
					<div style="margin-top:6px">No existing entries will be removed.</div>
				{/if}
			</div>
			<button
				type="submit"
				name="confirmed"
				value="1"
				formaction="?/import"
				class="btn {mode === 'merge' ? 'btn-primary' : 'btn-danger'}"
				style="margin-top:10px"
				disabled={applying}
			>
				{applying
					? 'Applying… please wait'
					: mode === 'merge'
						? 'Apply merge'
						: mode === 'sync'
							? 'Confirm synchronization'
							: 'Confirm full replace'}
			</button>
		{/if}

		{#if applying}
			<div class="alert alert-info" style="margin-top:12px">
				<strong>Applying changes…</strong> Do not close or refresh this page.
			</div>
		{/if}
	</form>
</div>

{#if data.hasCollection}
	<div class="card">
		<div
			style="font-size: 13px; color: var(--text-muted); margin-bottom: {data.unenrichedCount > 0
				? '16px'
				: '0'}"
		>
			You currently have <strong style="color: var(--text)"
				>{data.collectionCount.toLocaleString()}</strong
			> collection entries.
		</div>

		{#if data.unenrichedCount > 0}
			<div class="alert alert-info" style="margin-bottom: 12px">
				<strong>{data.unenrichedCount.toLocaleString()}</strong> entries are missing Scryfall data (type,
				price, image, location). Use the button below to fetch it without re-uploading your CSV.
			</div>
			<form
				method="POST"
				action="?/enrichExisting"
				use:enhance={() => {
					enriching = true;
					return async ({ update }) => {
						await update();
						enriching = false;
					};
				}}
			>
				<button type="submit" class="btn btn-primary" disabled={enriching}>
					{enriching
						? 'Fetching Scryfall data… please wait'
						: `Enrich ${data.unenrichedCount.toLocaleString()} cards with Scryfall data`}
				</button>
				{#if enriching}
					<div class="alert alert-info" style="margin-top: 12px">
						<strong>Working…</strong> Fetching card data from Scryfall in batches. For ~8k cards this
						takes about 35 seconds — do not close or refresh.
					</div>
				{/if}
			</form>
		{/if}
	</div>
{/if}
