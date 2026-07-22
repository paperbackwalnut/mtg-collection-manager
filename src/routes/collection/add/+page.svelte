<script lang="ts">
	import type { ActionData } from './$types';
	import { enhance } from '$app/forms';

	let { form }: { form: ActionData } = $props();

	// ── Card search autocomplete ──────────────────────────────────────────────
	let searchQuery = $state('');
	let suggestions = $state<string[]>([]);
	let suggestionsOpen = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	function onSearchInput() {
		if (searchTimer) clearTimeout(searchTimer);
		if (searchQuery.length < 2) {
			suggestions = [];
			suggestionsOpen = false;
			return;
		}
		searchTimer = setTimeout(async () => {
			const res = await fetch(`/api/scryfall/search?q=${encodeURIComponent(searchQuery)}`);
			suggestions = await res.json();
			suggestionsOpen = suggestions.length > 0;
		}, 200);
	}

	// ── Printings ─────────────────────────────────────────────────────────────
	type Printing = {
		id: string;
		name: string;
		set_code: string;
		collector_number: string;
		image_uri: string | null;
		price_usd: number | null;
		price_usd_foil: number | null;
		type_line: string;
		mana_cost: string;
	};
	let printings = $state<Printing[]>([]);
	let printingsLoading = $state(false);
	let selectedCard = $state('');

	async function selectCard(name: string) {
		selectedCard = name;
		searchQuery = name;
		suggestionsOpen = false;
		printings = [];
		selectedPrinting = null;
		printingsLoading = true;
		const res = await fetch(`/api/scryfall/printings?name=${encodeURIComponent(name)}`);
		printings = await res.json();
		printingsLoading = false;
	}

	// ── Printing selection ────────────────────────────────────────────────────
	let selectedPrinting = $state<Printing | null>(null);
	let foil = $state(false);

	function selectPrinting(p: Printing) {
		selectedPrinting = p;
		foil = false;
		// Scroll form into view
		setTimeout(
			() =>
				document.getElementById('add-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
			50
		);
	}

	// ── Form reset after success ──────────────────────────────────────────────
	$effect(() => {
		if (form?.success) {
			// Keep the card selected so you can quickly add another printing
			selectedPrinting = null;
		}
	});
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Add Card to Collection</h1>
		<p class="page-subtitle">Search Scryfall, pick a printing, set details</p>
	</div>
	<div class="flex gap-2">
		<a href="/collection" class="btn">← Collection</a>
	</div>
</div>

{#if form?.success}
	<div class="alert alert-success" style="margin-bottom:14px">
		✓ {form.merged
			? `Merged — ${form.name} now has ${form.quantity} cop${form.quantity !== 1 ? 'ies' : 'y'} in collection`
			: `Added ${form.quantity}× ${form.name} to collection`}
	</div>
{/if}
{#if form?.error}
	<div class="alert alert-error" style="margin-bottom:14px">✗ {form.error}</div>
{/if}

<!-- Step 1: search -->
<div class="card mb-2" style="overflow:visible">
	<div style="font-weight:600;margin-bottom:10px;font-size:13px">1. Find a card</div>
	<div style="position:relative;max-width:480px">
		<input
			type="text"
			placeholder="Card name… (e.g. Sol Ring)"
			bind:value={searchQuery}
			oninput={onSearchInput}
			onfocus={() => {
				if (suggestions.length) suggestionsOpen = true;
			}}
			style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:14px"
			autocomplete="off"
			spellcheck="false"
		/>
		{#if suggestionsOpen && suggestions.length > 0}
			<div
				style="position:absolute;left:0;right:0;top:100%;z-index:50;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.25);max-height:260px;overflow-y:auto;margin-top:2px"
			>
				{#each suggestions as name}
					<button
						style="display:block;width:100%;padding:8px 14px;background:none;border:none;cursor:pointer;font-size:13px;color:var(--text);text-align:left;border-bottom:1px solid var(--border)"
						onclick={() => selectCard(name)}>{name}</button
					>
				{/each}
			</div>
		{/if}
	</div>
</div>

<!-- click-outside to close suggestions -->
{#if suggestionsOpen}
	<div
		style="position:fixed;inset:0;z-index:40"
		onclick={() => (suggestionsOpen = false)}
		role="presentation"
		aria-hidden="true"
	></div>
{/if}

<!-- Step 2: pick a printing -->
{#if selectedCard && (printingsLoading || printings.length > 0)}
	<div class="card mb-2">
		<div style="font-weight:600;margin-bottom:10px;font-size:13px">2. Choose a printing</div>
		{#if printingsLoading}
			<div class="text-muted text-sm">Loading printings…</div>
		{:else if printings.length === 0}
			<div class="text-muted text-sm">No printings found in local Scryfall cache.</div>
		{:else}
			<div
				style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;max-height:400px;overflow-y:auto;padding:2px"
			>
				{#each printings as p}
					{@const isSelected = selectedPrinting?.id === p.id}
					<button
						onclick={() => selectPrinting(p)}
						style="background:none;border:2px solid {isSelected
							? 'var(--accent)'
							: 'var(--border)'};border-radius:8px;padding:6px;cursor:pointer;text-align:center;transition:border-color .1s"
					>
						{#if p.image_uri}
							<img
								src={p.image_uri}
								alt={p.name}
								style="width:100%;border-radius:5px;display:block;margin-bottom:4px"
							/>
						{:else}
							<div
								style="aspect-ratio:63/88;background:var(--surface-2);border-radius:5px;margin-bottom:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text-muted)"
							>
								{p.set_code.toUpperCase()}
							</div>
						{/if}
						<div style="font-size:10px;font-weight:600;color:var(--text)">
							{p.set_code.toUpperCase()} #{p.collector_number}
						</div>
						{#if p.price_usd != null}
							<div style="font-size:10px;color:var(--text-muted)">${p.price_usd.toFixed(2)}</div>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<!-- Step 3: fill in details -->
{#if selectedPrinting}
	<div class="card" id="add-form">
		<div style="font-weight:600;margin-bottom:12px;font-size:13px">3. Details</div>
		<div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start">
			{#if selectedPrinting.image_uri}
				<img
					src={selectedPrinting.image_uri}
					alt={selectedPrinting.name}
					style="width:90px;border-radius:6px;flex-shrink:0"
				/>
			{/if}
			<div style="font-size:13px;color:var(--text-muted)">
				<div style="font-weight:600;color:var(--text);font-size:14px;margin-bottom:2px">
					{selectedPrinting.name}
				</div>
				<div>{selectedPrinting.set_code.toUpperCase()} #{selectedPrinting.collector_number}</div>
				{#if selectedPrinting.type_line}<div>{selectedPrinting.type_line}</div>{/if}
				{#if selectedPrinting.price_usd != null}
					<div>
						${selectedPrinting.price_usd.toFixed(2)} non-foil
						{#if selectedPrinting.price_usd_foil != null}· ${selectedPrinting.price_usd_foil.toFixed(
								2
							)} foil{/if}
					</div>
				{/if}
			</div>
		</div>

		<form method="POST" action="?/add" use:enhance>
			<input type="hidden" name="name" value={selectedPrinting.name} />
			<input type="hidden" name="setCode" value={selectedPrinting.set_code} />
			<input type="hidden" name="collectorNumber" value={selectedPrinting.collector_number} />
			<input type="hidden" name="foil" value={String(foil)} />
			<div style="display:grid;grid-template-columns:80px 1fr 1fr 1fr;gap:10px;margin-bottom:10px">
				<div class="form-group" style="margin:0">
					<label for="add-qty">Quantity</label>
					<input type="number" id="add-qty" name="quantity" value="1" min="1" max="999" />
				</div>
				<div class="form-group" style="margin:0">
					<label for="add-condition">Condition</label>
					<select id="add-condition" name="condition">
						{#each ['NM', 'LP', 'MP', 'HP', 'DMG'] as c}
							<option value={c}>{c}</option>
						{/each}
					</select>
				</div>
				<div class="form-group" style="margin:0">
					<label for="add-language">Language</label>
					<select id="add-language" name="language">
						{#each ['English', 'Japanese', 'German', 'French', 'Spanish', 'Portuguese', 'Italian', 'Korean', 'Russian', 'Chinese Simplified', 'Chinese Traditional'] as l}
							<option value={l}>{l}</option>
						{/each}
					</select>
				</div>
				<div class="form-group" style="margin:0">
					<label for="add-loc">Location</label>
					<select id="add-loc" name="locationOverride">
						<option value="">Auto</option>
						<option value="binder">Binder</option>
						<option value="holding_box">Holding Box</option>
						<option value="box_w">White Box</option>
						<option value="box_u">Blue Box</option>
						<option value="box_b">Black Box</option>
						<option value="box_r">Red Box</option>
						<option value="box_g">Green Box</option>
						<option value="box_multi">Multicolor Box</option>
						<option value="box_colorless">Colorless Box</option>
						<option value="box_land">Land Box</option>
						<option value="proxy_box">Proxy Box</option>
					</select>
				</div>
			</div>

			<div style="display:flex;gap:16px;align-items:center;margin-bottom:14px">
				<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
					<input type="checkbox" bind:checked={foil} style="width:15px;height:15px" />
					Foil
				</label>
			</div>

			<div class="form-group" style="margin-bottom:14px">
				<label for="add-tags">Tags (comma-separated)</label>
				<input type="text" id="add-tags" name="tags" placeholder="e.g. commander, staple" />
			</div>

			<div class="flex gap-2">
				<button type="submit" class="btn btn-primary">+ Add to Collection</button>
				<button type="button" class="btn" onclick={() => (selectedPrinting = null)}>Cancel</button>
			</div>
		</form>
	</div>
{/if}
