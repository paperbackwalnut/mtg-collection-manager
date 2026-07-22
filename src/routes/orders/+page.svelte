<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Pre-fill from URL params (e.g. from picklist "+ Order" link)
	const prefillCard = page.url.searchParams.get('card') ?? '';
	const prefillSet = page.url.searchParams.get('set') ?? '';
	const prefillCn = page.url.searchParams.get('cn') ?? '';

	let showArrived = $state(false);

	const pendingOrders = $derived(data.orders.filter((o) => o.status === 'ordered'));
	const doneOrders = $derived(data.orders.filter((o) => o.status !== 'ordered'));

	const SOURCE_LABELS: Record<string, string> = {
		tcgplayer: 'TCGPlayer',
		ebay: 'eBay',
		lgs: 'LGS',
		other: 'Other'
	};

	function formatDate(ts: number) {
		return new Date(ts).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Orders</h1>
		<p class="page-subtitle">
			{#if pendingOrders.length > 0}
				<span style="color:var(--warning);font-weight:600">{pendingOrders.length} pending</span> · in
				transit
			{:else}
				No pending orders
			{/if}
		</p>
	</div>
</div>

{#if form?.error}
	<div class="alert alert-error" style="margin-bottom:12px">✗ {form.error}</div>
{/if}
{#if form?.success}
	<div class="alert alert-success" style="margin-bottom:12px">✓ Saved</div>
{/if}

<!-- Add order form -->
<div class="card mb-2">
	<div style="font-weight:600;margin-bottom:12px">+ Add Order</div>
	<form method="POST" action="?/add" use:enhance>
		<div
			style="display:grid;grid-template-columns:2fr 1fr 1fr 80px 1fr;gap:10px;margin-bottom:10px"
		>
			<div class="form-group" style="margin:0">
				<label for="cardName">Card Name *</label>
				<input
					type="text"
					id="cardName"
					name="cardName"
					value={prefillCard}
					placeholder="Sol Ring"
					required
				/>
			</div>
			<div class="form-group" style="margin:0">
				<label for="setCode">Set Code</label>
				<input
					type="text"
					id="setCode"
					name="setCode"
					value={prefillSet}
					placeholder="CMR"
					style="text-transform:uppercase"
				/>
			</div>
			<div class="form-group" style="margin:0">
				<label for="collectorNumber">Collector #</label>
				<input
					type="text"
					id="collectorNumber"
					name="collectorNumber"
					value={prefillCn}
					placeholder="319"
				/>
			</div>
			<div class="form-group" style="margin:0">
				<label for="quantity">Qty</label>
				<input type="number" id="quantity" name="quantity" value="1" min="1" max="99" />
			</div>
			<div class="form-group" style="margin:0">
				<label for="source">Source</label>
				<select id="source" name="source">
					<option value="tcgplayer">TCGPlayer</option>
					<option value="ebay">eBay</option>
					<option value="lgs">LGS</option>
					<option value="other" selected>Other</option>
				</select>
			</div>
		</div>
		<div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end">
			<div class="form-group" style="margin:0">
				<label for="notes">Notes (optional)</label>
				<input
					type="text"
					id="notes"
					name="notes"
					placeholder="e.g. from eBay seller xyz, awaiting shipping"
				/>
			</div>
			<button type="submit" class="btn btn-primary">Add Order</button>
		</div>
	</form>
</div>

<!-- Pending orders -->
{#if pendingOrders.length > 0}
	<div class="card mb-2" style="padding:0">
		<div style="padding:12px 14px;border-bottom:1px solid var(--border);font-weight:600">
			Pending Orders ({pendingOrders.length})
		</div>
		<table class="data-table">
			<thead>
				<tr>
					<th>Card</th>
					<th>Set / #</th>
					<th>Qty</th>
					<th>Source</th>
					<th>Notes</th>
					<th>Ordered</th>
					<th>Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each pendingOrders as order}
					<tr>
						<td style="font-weight:500">{order.cardName}</td>
						<td class="mono text-muted text-sm">
							{#if order.setCode}
								{order.setCode.toUpperCase()} #{order.collectorNumber ?? '—'}
							{:else}
								<span class="text-muted">—</span>
							{/if}
						</td>
						<td>{order.quantity}</td>
						<td><span class="badge">{SOURCE_LABELS[order.source] ?? order.source}</span></td>
						<td class="text-muted text-sm">{order.notes ?? '—'}</td>
						<td class="text-muted text-sm">{formatDate(order.orderedAt)}</td>
						<td>
							<div class="flex gap-1">
								<form method="POST" action="?/markArrived" use:enhance style="display:inline">
									<input type="hidden" name="id" value={order.id} />
									<input type="hidden" name="addToCollection" value="true" />
									<button
										type="submit"
										class="btn btn-sm"
										style="color:var(--success)"
										title="Mark arrived & add to collection">✓ Arrived</button
									>
								</form>
								<form method="POST" action="?/cancel" use:enhance style="display:inline">
									<input type="hidden" name="id" value={order.id} />
									<button
										type="submit"
										class="btn btn-sm"
										style="color:var(--warning)"
										title="Cancel order">✕ Cancel</button
									>
								</form>
								<form method="POST" action="?/delete" use:enhance style="display:inline">
									<input type="hidden" name="id" value={order.id} />
									<button type="submit" class="btn btn-sm btn-danger" title="Delete">Del</button>
								</form>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else}
	<div class="empty-state" style="padding:24px;text-align:center;color:var(--text-muted)">
		No pending orders. Use the form above to track cards you've ordered.
	</div>
{/if}

<!-- Arrived / Cancelled (collapsible) -->
{#if doneOrders.length > 0}
	<div class="card" style="padding:0">
		<button
			style="width:100%;text-align:left;padding:12px 14px;background:none;border:none;cursor:pointer;font-weight:600;color:var(--text-muted);display:flex;justify-content:space-between;align-items:center"
			onclick={() => (showArrived = !showArrived)}
		>
			<span>Past Orders ({doneOrders.length})</span>
			<span>{showArrived ? '▲' : '▼'}</span>
		</button>
		{#if showArrived}
			<table class="data-table" style="opacity:0.7">
				<thead>
					<tr>
						<th>Card</th>
						<th>Set / #</th>
						<th>Qty</th>
						<th>Source</th>
						<th>Status</th>
						<th>Ordered</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each doneOrders as order}
						<tr>
							<td style="font-weight:500">{order.cardName}</td>
							<td class="mono text-muted text-sm">
								{#if order.setCode}
									{order.setCode.toUpperCase()} #{order.collectorNumber ?? '—'}
								{:else}
									<span class="text-muted">—</span>
								{/if}
							</td>
							<td>{order.quantity}</td>
							<td><span class="badge">{SOURCE_LABELS[order.source] ?? order.source}</span></td>
							<td>
								<span
									style="display:inline-flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap"
								>
									<span
										class="status-dot"
										style="background:{order.status === 'arrived'
											? 'var(--success)'
											: 'var(--text-muted)'}"
									></span>
									<span style="color:var(--text-muted)">{order.status}</span>
								</span>
							</td>
							<td class="text-muted text-sm">{formatDate(order.orderedAt)}</td>
							<td>
								<form method="POST" action="?/delete" use:enhance style="display:inline">
									<input type="hidden" name="id" value={order.id} />
									<button type="submit" class="btn btn-sm btn-danger" title="Delete">Del</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
{/if}
