<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';
	import { removeItem, updateItem, clearAll, addItem } from '$lib/shopping-list';
	import type { ShoppingItem } from '$lib/shopping-list';

	let { data }: { data: PageData } = $props();

	let items = $derived(data.items as ShoppingItem[]);
	let addName = $state('');
	let addQty = $state(1);
	let editingName = $state<string | null>(null);

	function focusOnMount(node: HTMLElement) {
		node.focus();
	}
	let feedback = $state('');
	let copyFeedback = $state('');
	let busy = $state(false);

	async function refresh() {
		await invalidateAll();
	}

	async function remove(cardName: string) {
		await removeItem(cardName);
		await refresh();
	}

	async function updateQty(cardName: string, delta: number) {
		const item = items.find((i) => i.cardName === cardName);
		if (!item) return;
		await updateItem(cardName, { quantity: Math.max(1, item.quantity + delta) });
		await refresh();
	}

	async function saveNote(cardName: string, notes: string) {
		editingName = null;
		await updateItem(cardName, { notes });
		await refresh();
	}

	async function addManual() {
		const name = addName.trim();
		if (!name || busy) return;
		busy = true;
		await addItem(name, addQty, 'manual');
		addName = '';
		addQty = 1;
		await refresh();
		busy = false;
	}

	async function clearList() {
		if (!confirm('Clear the entire Shopping List?')) return;
		await clearAll();
		await refresh();
	}

	async function moveToOrders(item: ShoppingItem) {
		const fd = new FormData();
		fd.set('cardName', item.cardName);
		fd.set('quantity', String(item.quantity));
		fd.set('source', 'other');
		if (item.notes) fd.set('notes', item.notes);

		const res = await fetch('/orders?/add', { method: 'POST', body: fd });
		if (res.ok) {
			await removeItem(item.cardName);
			await refresh();
			feedback = `${item.cardName} moved to Orders`;
			setTimeout(() => (feedback = ''), 3000);
		}
	}

	async function copyList(withNotes = false) {
		const lines = items.map((i) => {
			const base = `${i.quantity} ${i.cardName}`;
			return withNotes && i.notes ? `${base} — ${i.notes}` : base;
		});
		await navigator.clipboard.writeText(lines.join('\n'));
		copyFeedback = 'Copied!';
		setTimeout(() => (copyFeedback = ''), 2000);
	}

	function formatDate(ts: number) {
		return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	const totalItems = $derived(items.reduce((s, i) => s + i.quantity, 0));
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Shopping List</h1>
		<p class="page-subtitle">
			{#if items.length > 0}
				{items.length} card{items.length !== 1 ? 's' : ''} · {totalItems} total copies
			{:else}
				Cards you may want to buy, proxy, or order later
			{/if}
		</p>
	</div>
	<div style="display:flex;gap:8px;align-items:center">
		{#if items.length > 0}
			<button
				class="btn btn-sm"
				onclick={() => copyList(false)}
				title="Copy plain list to clipboard"
			>
				{copyFeedback || 'Copy list'}
			</button>
			<button
				class="btn btn-sm"
				style="color:var(--danger);border-color:var(--danger)"
				onclick={clearList}
			>
				Clear all
			</button>
		{/if}
	</div>
</div>

{#if feedback}
	<div class="alert alert-success" style="margin-bottom:12px">{feedback}</div>
{/if}

<!-- Add card manually -->
<div class="card mb-2">
	<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
		<div style="flex:1;min-width:180px">
			<label for="sl-name" style="font-size:12px;font-weight:600;display:block;margin-bottom:4px"
				>Card name</label
			>
			<input
				id="sl-name"
				type="text"
				placeholder="e.g. Sol Ring"
				bind:value={addName}
				style="width:100%"
				onkeydown={(e) => e.key === 'Enter' && addManual()}
			/>
		</div>
		<div style="width:70px">
			<label for="sl-qty" style="font-size:12px;font-weight:600;display:block;margin-bottom:4px"
				>Qty</label
			>
			<input id="sl-qty" type="number" min="1" bind:value={addQty} style="width:100%" />
		</div>
		<button class="btn btn-primary" onclick={addManual} disabled={!addName.trim() || busy}
			>Add</button
		>
	</div>
</div>

{#if items.length === 0}
	<div class="empty-state">
		<p>Your Shopping List is empty.</p>
		<p class="text-muted text-sm" style="margin-top:6px">
			Add cards from <a href="/shortfalls">Shortfalls</a> or <a href="/missing">Missing</a>, or use
			the form above.
		</p>
	</div>
{:else}
	<table class="data-table">
		<thead>
			<tr>
				<th style="width:35%">Card</th>
				<th>Qty</th>
				<th>Notes</th>
				<th>Added</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each items as item}
				<tr>
					<td>
						<a
							href="/cards/{encodeURIComponent(item.cardName)}"
							class="card-link"
							style="font-weight:600"
						>
							{item.cardName}
						</a>
						{#if item.source && item.source !== 'manual'}
							<span style="font-size:10px;color:var(--text-muted);margin-left:4px"
								>({item.source})</span
							>
						{/if}
					</td>
					<td>
						<div style="display:flex;align-items:center;gap:4px">
							<button
								class="act-chip"
								style="padding:1px 6px;font-size:13px;font-weight:700"
								onclick={() => updateQty(item.cardName, -1)}
								disabled={item.quantity <= 1}
								title="Decrease">−</button
							>
							<span style="font-weight:600;min-width:20px;text-align:center">{item.quantity}</span>
							<button
								class="act-chip"
								style="padding:1px 6px;font-size:13px;font-weight:700"
								onclick={() => updateQty(item.cardName, 1)}
								title="Increase">+</button
							>
						</div>
					</td>
					<td>
						{#if editingName === item.cardName}
							<input
								type="text"
								value={item.notes ?? ''}
								style="font-size:12px;padding:2px 6px;width:100%;border:1px solid var(--accent);border-radius:4px;background:var(--surface);color:var(--text)"
								use:focusOnMount
								onblur={(e) => saveNote(item.cardName, (e.target as HTMLInputElement).value)}
								onkeydown={(e) => {
									if (e.key === 'Enter')
										saveNote(item.cardName, (e.target as HTMLInputElement).value);
									if (e.key === 'Escape') editingName = null;
								}}
							/>
						{:else}
							<button
								style="background:none;border:none;cursor:pointer;font-size:12px;color:{item.notes
									? 'var(--text)'
									: 'var(--text-muted)'};text-align:left;padding:0"
								onclick={() => (editingName = item.cardName)}
								title="Click to edit note"
							>
								{item.notes || 'Add note…'}
							</button>
						{/if}
					</td>
					<td style="font-size:11px;color:var(--text-muted);white-space:nowrap"
						>{formatDate(item.addedAt)}</td
					>
					<td>
						<div style="display:flex;gap:5px;white-space:nowrap">
							<button
								class="act-chip act-chip-order"
								style="font-size:11px"
								onclick={() => moveToOrders(item)}
								title="Move to Orders">→ Order</button
							>
							<button
								class="act-chip"
								style="font-size:11px;color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,transparent)"
								onclick={() => remove(item.cardName)}
								title="Remove from list">✕</button
							>
						</div>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>

	<div style="margin-top:10px;display:flex;gap:8px;align-items:center">
		<button class="btn btn-sm" onclick={() => copyList(false)}>Copy list</button>
		<button class="btn btn-sm" onclick={() => copyList(true)} title="Include notes in copied text"
			>Copy with notes</button
		>
		{#if copyFeedback}
			<span style="font-size:12px;color:var(--success);font-weight:600">{copyFeedback}</span>
		{/if}
		<span class="text-muted text-sm" style="margin-left:auto">
			Stored on server · Use → Order to track purchases
		</span>
	</div>
{/if}
