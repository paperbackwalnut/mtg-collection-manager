<script lang="ts">
	import { untrack } from 'svelte';
	import type { ActionData } from './$types';
	import { enhance } from '$app/forms';

	let { form }: { form: ActionData } = $props();
	let activeTab = $state<'text' | 'moxfield' | 'bulk'>(
		untrack(() => (form?.tab === 'moxfield' ? 'moxfield' : form?.tab === 'bulk' ? 'bulk' : 'text'))
	);
	let loading = $state(false);

	const EXAMPLE_LIST = `1 Command Tower
1 Sol Ring
1 Arcane Signet
// Commander
1 Atraxa, Praetors' Voice
// Sideboard
1 Cultivate`;
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Import Deck</h1>
		<p class="page-subtitle">Add a deck from a text list or Moxfield URL</p>
	</div>
	<a href="/decks" class="btn">← Back</a>
</div>

{#if form?.error}
	<div class="alert alert-error">✗ {form.error}</div>
{/if}

{#if form?.duplicate}
	<div class="card" style="border-color: var(--warning)">
		<div style="font-weight:600;margin-bottom:8px">Duplicate deck detected</div>
		<p style="color:var(--text-muted);margin:0 0 12px;font-size:13px">
			A deck named <strong style="color:var(--text)">"{form.existingName}"</strong> already exists. Open
			the existing deck, or create a separate new deck.
		</p>
		<div class="flex gap-2">
			{#if form.tab === 'moxfield'}
				<form method="POST" action="?/importMoxfield">
					<input type="hidden" name="url" value={form.url} />
					<input type="hidden" name="createAnyway" value="true" />
					<button type="submit" class="btn" disabled={loading}>Create new deck anyway</button>
				</form>
			{:else}
				<form method="POST" action="?/importText">
					<input type="hidden" name="name" value={form.name} />
					<input type="hidden" name="format" value={form.format ?? ''} />
					<input type="hidden" name="decklist" value={form.decklist} />
					<input type="hidden" name="createAnyway" value="true" />
					<button type="submit" class="btn" disabled={loading}>Create new deck anyway</button>
				</form>
			{/if}
			<a href="/decks/{form.existingId}" class="btn btn-primary">Open existing deck</a>
		</div>
	</div>
{/if}

<div class="tabs">
	<button class="tab" class:active={activeTab === 'text'} onclick={() => (activeTab = 'text')}>
		Paste Text
	</button>
	<button
		class="tab"
		class:active={activeTab === 'moxfield'}
		onclick={() => (activeTab = 'moxfield')}
	>
		Moxfield URL
	</button>
	<button class="tab" class:active={activeTab === 'bulk'} onclick={() => (activeTab = 'bulk')}>
		Bulk Moxfield
	</button>
</div>

{#if activeTab === 'text'}
	<div class="card">
		<form
			method="POST"
			action="?/importText"
			use:enhance={() => {
				loading = true;
				return async ({ update }) => {
					await update();
					loading = false;
				};
			}}
		>
			<div class="form-group">
				<label for="name">Deck Name *</label>
				<input type="text" id="name" name="name" placeholder="My Commander Deck" required />
			</div>
			<div class="form-group">
				<label for="format">Format</label>
				<select id="format" name="format">
					<option value="">— Select —</option>
					<option>commander</option>
					<option>standard</option>
					<option>modern</option>
					<option>legacy</option>
					<option>pauper</option>
					<option>vintage</option>
					<option>pioneer</option>
					<option>draft</option>
				</select>
			</div>
			<div class="form-group">
				<label for="decklist">Decklist *</label>
				<textarea id="decklist" name="decklist" rows="16" placeholder={EXAMPLE_LIST} required
				></textarea>
				<div class="form-hint">
					Supported formats: <span class="mono">4 Sol Ring</span>,
					<span class="mono">4x Sol Ring</span>,
					<span class="mono">1 Sol Ring (CMR) 319</span>.<br />
					Use <span class="mono">// Commander</span>, <span class="mono">// Sideboard</span> section
					headers.
					<span class="mono">SB:</span> prefix also works.
				</div>
			</div>
			<button type="submit" class="btn btn-primary" disabled={loading}>
				{loading ? 'Importing… (this may take a moment)' : 'Import Deck'}
			</button>
		</form>
	</div>
{:else if activeTab === 'moxfield'}
	<div class="card">
		<form
			method="POST"
			action="?/importMoxfield"
			use:enhance={() => {
				loading = true;
				return async ({ update }) => {
					await update();
					loading = false;
				};
			}}
		>
			<div class="form-group">
				<label for="url">Moxfield Deck URL *</label>
				<input
					type="url"
					id="url"
					name="url"
					placeholder="https://www.moxfield.com/decks/..."
					required
				/>
				<div class="form-hint">
					Works with public and unlisted decks. The deck name and format will be imported
					automatically.
				</div>
			</div>
			<button type="submit" class="btn btn-primary" disabled={loading}>
				{loading ? 'Fetching from Moxfield…' : 'Import from Moxfield'}
			</button>
		</form>
	</div>
{:else}
	<!-- Bulk Moxfield import -->
	{#if form?.bulkResults}
		<div class="card mb-2">
			<div style="font-weight:600;margin-bottom:10px">
				Import complete —
				{form.bulkResults.filter((r: any) => r.status === 'imported').length} imported,
				{form.bulkResults.filter((r: any) => r.status === 'skipped').length} skipped (already exist),
				{form.bulkResults.filter((r: any) => r.status === 'error').length} failed
			</div>
			{#each form.bulkResults as r}
				<div
					style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px"
				>
					{#if r.status === 'imported'}
						<span style="color:var(--success)">✓</span>
						<a href="/decks/{r.deckId}" style="font-weight:500">{r.name}</a>
					{:else if r.status === 'skipped'}
						<span style="color:var(--text-muted)">–</span>
						<span class="text-muted"
							>{r.name} <span style="font-size:11px">(already imported)</span></span
						>
					{:else}
						<span style="color:var(--error)">✗</span>
						<span class="text-muted">{r.url.slice(0, 50)}…</span>
						<span style="color:var(--error);font-size:11px">{r.error}</span>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<div class="card">
		<form
			method="POST"
			action="?/importMoxfieldBulk"
			use:enhance={() => {
				loading = true;
				return async ({ update }) => {
					await update();
					loading = false;
				};
			}}
		>
			<div class="form-group">
				<label for="urls">Moxfield Deck URLs</label>
				<textarea
					id="urls"
					name="urls"
					rows="10"
					placeholder="https://www.moxfield.com/decks/abc123
https://www.moxfield.com/decks/def456
https://www.moxfield.com/decks/ghi789"
				></textarea>
				<div class="form-hint">
					One URL per line. Decks already imported (matched by URL) will be skipped.
				</div>
			</div>
			<button type="submit" class="btn btn-primary" disabled={loading}>
				{loading ? 'Importing decks…' : 'Import All'}
			</button>
			{#if loading}
				<div class="alert alert-info" style="margin-top:12px">
					<strong>Working…</strong> Fetching each deck from Moxfield in sequence. Don't close this tab.
				</div>
			{/if}
		</form>
	</div>
{/if}
