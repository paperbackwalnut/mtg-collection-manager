<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let seeding = $state(false);
	let refreshing = $state(false);

	// Upload fallback state
	let fileInput = $state<HTMLInputElement | null>(null);
	let uploading = $state(false);
	let uploadResult = $state<{ inserted?: number; total?: number; error?: string } | null>(null);

	function formatDate(ms: number | null): string {
		if (!ms) return 'never';
		return new Date(ms).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function formatAge(ms: number | null): string {
		if (!ms) return '';
		const days = Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
		if (days === 0) return ' (today)';
		if (days === 1) return ' (yesterday)';
		return ` (${days} days ago)`;
	}

	// Upload fallback: sends file as raw body to avoid form buffering
	// Note: only use when local file isn't available — Vite dev server buffers
	// large request bodies in memory before calling the handler.
	async function startUpload() {
		const file = fileInput?.files?.[0];
		if (!file) return;

		uploading = true;
		uploadResult = null;

		try {
			const res = await fetch('/api/scryfall/seed', {
				method: 'POST',
				body: file,
				headers: { 'Content-Type': 'application/octet-stream' }
			});
			uploadResult = await res.json();
		} catch (e) {
			uploadResult = { error: String(e) };
		} finally {
			uploading = false;
		}
	}
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Scryfall Cache</h1>
		<p class="page-subtitle">Load card metadata into the local Scryfall cache</p>
	</div>
	<a href="/collection" class="btn">← Back</a>
</div>

<!-- Cache status -->
<div class="card mb-2">
	<h2 style="margin:0 0 10px;font-size:15px">Current Cache Status</h2>
	<div style="display:flex;gap:32px;flex-wrap:wrap">
		<div>
			<div class="text-muted text-sm">Cards cached locally</div>
			<div style="font-size:26px;font-weight:700;color:var(--text)">
				{data.cacheTotal.toLocaleString()}
			</div>
			<div class="text-muted text-sm" style="margin-top:2px">
				{#if data.cacheTotal > 200000}
					✓ Fully seeded — enrichment queries only hit the DB
				{:else if data.cacheTotal > 0}
					⚠ Partial — seed below for full coverage (~280k total)
				{:else}
					✗ Empty — seed to enable instant enrichment
				{/if}
			</div>
		</div>
		<div>
			<div class="text-muted text-sm">Last updated</div>
			<div style="font-size:15px;font-weight:600;color:var(--text)">
				{formatDate(data.lastUpdated)}{formatAge(data.lastUpdated)}
			</div>
		</div>
	</div>
</div>

<!-- Recommended setup -->
<div class="card mb-2">
	<h2 style="margin:0 0 4px;font-size:15px">Recommended: Download and Build Automatically</h2>
	<p class="text-muted text-sm" style="margin:0 0 12px">
		Downloads Scryfall Default Cards (roughly 500 MB), builds the local cache, and removes the
		download afterward.
	</p>
	{#if form?.refreshSuccess}
		<div class="alert alert-success" style="margin-bottom:12px">
			✓ Local Scryfall cache is ready with <strong>{(form.total ?? 0).toLocaleString()}</strong>
			cards.
		</div>
	{/if}
	{#if form?.error}
		<div class="alert alert-error" style="margin-bottom:12px">✗ {form.error}</div>
	{/if}
	{#if data.cacheTotal > 0}
		<div class="alert alert-success">✓ Local cache setup is complete.</div>
	{:else}
		<form
			method="POST"
			action="?/refreshFromScryfall"
			use:enhance={() => {
				refreshing = true;
				return async ({ update }) => {
					try {
						await update();
					} finally {
						refreshing = false;
					}
				};
			}}
		>
			<button type="submit" class="btn btn-primary" disabled={refreshing || seeding || uploading}>
				{refreshing ? 'Downloading and building…' : 'Set up local cache'}
			</button>
			{#if refreshing}
				<div class="alert alert-info" style="margin-top:12px">
					This can take several minutes. Keep this page open; progress is also shown in the
					terminal.
				</div>
			{/if}
		</form>
	{/if}
</div>

<!-- How it works -->
<div class="card mb-2">
	<h2 style="margin:0 0 8px;font-size:15px">How It Works</h2>
	<p style="font-size:13px;color:var(--text-muted);margin:0 0 8px">
		Scryfall publishes a <a
			href="https://scryfall.com/docs/api/bulk-data"
			target="_blank"
			rel="noopener"
			style="color:var(--accent)">bulk JSON file</a
		>
		(~500 MB, ~280k cards) with images, types, prices, and set info for every MTG card. Seeding the local
		cache makes future imports and enrichment fast local lookups — no network calls to Scryfall, no rate
		limiting, works on any machine.
	</p>
	<ol style="font-size:13px;color:var(--text-muted);padding-left:20px;margin:0">
		<li>
			Go to <a
				href="https://scryfall.com/docs/api/bulk-data"
				target="_blank"
				rel="noopener"
				style="color:var(--accent)">scryfall.com/docs/api/bulk-data</a
			>
			→ download <strong>Default Cards</strong> (~500 MB)
		</li>
		<li>
			Rename it to <code style="background:var(--surface-2);padding:1px 5px;border-radius:3px"
				>scryfall-bulk.json</code
			> and place it in the project root
		</li>
		<li>Click <strong>Seed from local file</strong> below — takes 2–5 min, logs in the terminal</li>
		<li>Done. Delete the local file after seeding if you want to save disk space.</li>
	</ol>
</div>

<!-- Primary: seed from local file -->
<div class="card mb-2">
	<h2 style="margin:0 0 4px;font-size:15px">Seed from Local File</h2>
	<p class="text-muted text-sm" style="margin:0 0 12px">
		Reads <code style="background:var(--surface-2);padding:1px 4px;border-radius:3px"
			>scryfall-bulk.json</code
		>
		from the project root directly — no upload, no memory issues.
	</p>

	{#if form?.seedSuccess}
		<div class="alert alert-success" style="margin-bottom:12px">
			✓ <strong>{(form.inserted ?? 0).toLocaleString()}</strong> new cards inserted
			{#if (form.skipped ?? 0) > 0}· {(form.skipped ?? 0).toLocaleString()} already existed{/if}
			· {(form.total ?? 0).toLocaleString()} total in file. Enrichment is now instant.
		</div>
	{/if}

	{#if data.localFileExists}
		<div class="alert alert-success" style="margin-bottom:12px;font-size:13px">
			✓ Found <code>scryfall-bulk.json</code> ({data.localFileSizeMB} MB) at:<br />
			<code style="font-size:11px;color:var(--text-muted)">{data.localBulkPath}</code>
		</div>
	{:else}
		<div class="alert alert-error" style="margin-bottom:12px;font-size:13px">
			✗ File not found. Expected at:<br />
			<code style="font-size:11px">{data.localBulkPath}</code>
		</div>
	{/if}

	<form
		method="POST"
		action="?/seedFromLocal"
		use:enhance={() => {
			seeding = true;
			return async ({ update }) => {
				await update();
				seeding = false;
			};
		}}
	>
		<button type="submit" class="btn btn-primary" disabled={seeding || !data.localFileExists}>
			{seeding ? 'Seeding… check terminal for progress' : 'Seed from local file'}
		</button>
		{#if seeding}
			<div class="alert alert-info" style="margin-top:12px">
				<strong>Working…</strong> Loading ~280k cards into the local cache in batches. Progress logs appear
				in the terminal. This takes 2–5 minutes — do not close or refresh.
			</div>
		{/if}
	</form>
</div>

<!-- Fallback: upload -->
<div class="card">
	<h2 style="margin:0 0 4px;font-size:15px">
		Upload File <span class="text-muted" style="font-weight:400;font-size:13px">(fallback)</span>
	</h2>
	<p class="text-muted text-sm" style="margin:0 0 8px">
		Use this only if you can't place the file in the project root (e.g. remote server). The dev
		server must buffer the full 500 MB before processing — may be slow or fail.
	</p>

	{#if uploadResult?.error}
		<div class="alert alert-error" style="margin-bottom:12px">✗ {uploadResult.error}</div>
	{:else if uploadResult?.inserted}
		<div class="alert alert-success" style="margin-bottom:12px">
			✓ Seeded <strong>{uploadResult.inserted.toLocaleString()}</strong> cards.
		</div>
	{/if}

	<div class="form-group">
		<label for="bulk-file">Scryfall Default Cards JSON</label>
		<input
			type="file"
			id="bulk-file"
			accept=".json,application/json"
			bind:this={fileInput}
			disabled={uploading}
		/>
	</div>
	<button class="btn" onclick={startUpload} disabled={uploading}>
		{uploading ? 'Uploading…' : 'Upload & Seed'}
	</button>
</div>
