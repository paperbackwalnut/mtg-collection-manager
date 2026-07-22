<script lang="ts">
	import type { PageData } from './$types';
	import { LOCATION_LABELS } from '$lib/types';
	import type { CardLocation } from '$lib/types';
	import { invalidateAll } from '$app/navigation';

	let { data }: { data: PageData } = $props();

	const STATUS_CLASSES: Record<string, string> = {
		needed: 'badge-needed',
		assigned: 'badge-assigned',
		pulled: 'badge-pulled',
		proxied: 'badge-proxied'
	};
	const STATUS_ICONS: Record<string, string> = {
		needed: '·',
		assigned: '·',
		pulled: '✓',
		proxied: '·'
	};

	let totalCopies = $derived(data.entries.reduce((s, e) => s + e.quantity, 0));
	let totalAvailable = $derived(data.entries.reduce((s, e) => s + e.available, 0));
	let totalAssigned = $derived(data.entries.reduce((s, e) => s + e.activeCount, 0));

	type CopyOption = {
		id: number;
		setCode: string;
		collectorNumber: string;
		foil: boolean;
		condition: string;
		quantity: number;
		available: number;
		locationOverride: string | null;
		conflicts: { deckName: string; status: string }[];
	};

	let copyPickerId = $state<number | null>(null);
	let copyPickerOptions = $state<CopyOption[]>([]);
	let copyPickerLoading = $state(false);
	let copyPickerBusy = $state(false);
	let copyPickerError = $state('');

	async function openCopyPicker(assignmentId: number) {
		if (copyPickerId === assignmentId) {
			copyPickerId = null;
			return;
		}
		copyPickerId = assignmentId;
		copyPickerOptions = [];
		copyPickerError = '';
		copyPickerLoading = true;
		try {
			const res = await fetch(`/api/assignments/${assignmentId}`);
			if (!res.ok) throw new Error('Could not load printings');
			copyPickerOptions = await res.json();
		} catch (error) {
			copyPickerError = error instanceof Error ? error.message : 'Could not load printings';
		} finally {
			copyPickerLoading = false;
		}
	}

	async function patchAssignment(assignmentId: number, body: Record<string, unknown>) {
		copyPickerBusy = true;
		copyPickerError = '';
		try {
			const res = await fetch(`/api/assignments/${assignmentId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const payload = await res.json().catch(() => null);
				throw new Error(payload?.message ?? 'Could not update assignment');
			}
			copyPickerId = null;
			await invalidateAll();
			copyPickerBusy = false;
		} catch (error) {
			copyPickerError = error instanceof Error ? error.message : 'Could not update assignment';
			copyPickerBusy = false;
		}
	}

	function pickCopy(assignmentId: number, copy: CopyOption, currentCollectionId: number | null) {
		if (copy.id === currentCollectionId) {
			copyPickerId = null;
			return;
		}
		const status = 'assigned';
		void patchAssignment(assignmentId, { status, collectionId: copy.id });
	}
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">{data.cardName}</h1>
		<p class="page-subtitle">
			{totalCopies} total · {totalAssigned} in decks · {totalAvailable} available
		</p>
	</div>
	<a href="/collection" class="btn">← Collection</a>
</div>

{#if data.entries[0]?.imageUri}
	{@const hero = data.entries[0]}
	<div class="flex gap-2 mb-2" style="align-items: flex-start">
		<img
			src={hero.imageUri}
			alt={data.cardName}
			style="width:180px;border-radius:10px;flex-shrink:0"
		/>
		{#if hero.backImageUri}
			<img
				src={hero.backImageUri}
				alt="{data.cardName} (back face)"
				style="width:180px;border-radius:10px;flex-shrink:0"
			/>
		{/if}
		<div style="flex:1">
			{#if hero.typeLine}
				<div class="text-sm text-muted mb-1">{hero.typeLine}</div>
			{/if}
			{#if hero.manaCost}
				<div class="text-sm mono mb-1">{hero.manaCost}</div>
			{/if}
			{#if hero.cmc != null}
				<div class="text-sm text-muted mb-1">CMC: {hero.cmc}</div>
			{/if}
		</div>
	</div>
{/if}

<h2 style="font-size:15px;font-weight:600;margin:0 0 10px">
	Your Copies ({data.entries.length} printing{data.entries.length !== 1 ? 's' : ''})
</h2>

{#each data.entries as entry}
	<div class="card mb-1">
		<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
			<div>
				<span class="mono" style="font-weight:600"
					>{entry.setCode.toUpperCase()} #{entry.collectorNumber}</span
				>
				{#if entry.foil}<span class="badge" style="margin-left:6px;color:var(--gold)">Foil</span
					>{/if}
				<span class="text-muted text-sm" style="margin-left:8px">{entry.condition}</span>
			</div>
			<div class="flex gap-2 align-center">
				<span class="loc-chip loc-{entry.location}">
					{LOCATION_LABELS[entry.location as CardLocation] ?? entry.location}
				</span>
				{#if entry.priceUsd}
					<span
						class="text-sm"
						style="color: {(entry.priceUsd ?? 0) >= 10 ? 'var(--warning)' : 'var(--text-muted)'}"
					>
						${entry.priceUsd.toFixed(2)}
					</span>
				{/if}
			</div>
		</div>

		<div
			style="display:flex;gap:16px;font-size:13px;margin-bottom: {entry.assignments.length > 0
				? '10px'
				: '0'}"
		>
			<span>Qty: <strong>{entry.quantity}</strong></span>
			<span style="color: var(--success)">Available: <strong>{entry.available}</strong></span>
			<span style="color: var(--warning)">In decks: <strong>{entry.activeCount}</strong></span>
		</div>

		{#if entry.assignments.length > 0}
			<div style="border-top: 1px solid var(--border); padding-top: 8px">
				<div class="text-sm text-muted mb-1">Deck assignments:</div>
				{#each entry.assignments as a}
					{@const displayStatus = a.status}
					<div class="card-assignment-row">
						<span class="badge {STATUS_CLASSES[displayStatus]}"
							>{STATUS_ICONS[displayStatus]} {displayStatus}</span
						>
						<a href="/decks/{a.deckId}" style="font-weight:500">{a.deckName}</a>
						{#if a.deckFormat}<span class="text-muted">({a.deckFormat})</span>{/if}
						<button
							class="assignment-printing-btn"
							disabled={copyPickerBusy}
							onclick={() => openCopyPicker(a.id)}
						>
							Change printing
						</button>
						{#if copyPickerId === a.id}
							<div class="assignment-copy-picker">
								<div class="assignment-copy-header">Assign printing — {data.cardName}</div>
								{#if copyPickerLoading}
									<div class="assignment-copy-msg">Loading...</div>
								{:else if copyPickerError}
									<div class="assignment-copy-msg assignment-copy-error">{copyPickerError}</div>
								{:else if copyPickerOptions.length === 0}
									<div class="assignment-copy-msg">Not in collection</div>
								{:else}
									{#each copyPickerOptions as copy}
										{@const isCurrent = copy.id === entry.id}
										{@const canAssign = copy.available > 0 || isCurrent}
										{#if !canAssign && copy.conflicts.length > 0}
											<div class="assignment-copy-conflict">
												<span class="mono"
													>{copy.setCode.toUpperCase()} #{copy.collectorNumber}{#if copy.foil}
														F{/if}</span
												>
												<span
													>used by {copy.conflicts
														.map((conflict) => conflict.deckName)
														.join(', ')}</span
												>
												<div class="assignment-copy-conflict-actions">
													<button
														class="assignment-copy-conflict-btn assignment-copy-conflict-btn--take"
														disabled={copyPickerBusy}
														onclick={() =>
															patchAssignment(a.id, {
																status: 'assigned',
																collectionId: copy.id,
																override: true,
																proxifyConflicts: true
															})}
													>
														Take it
													</button>
													<button
														class="assignment-copy-conflict-btn assignment-copy-conflict-btn--proxy"
														disabled={copyPickerBusy}
														onclick={() =>
															patchAssignment(a.id, { status: 'proxied', collectionId: null })}
													>
														Proxy this slot
													</button>
												</div>
											</div>
										{:else}
											<button
												class="assignment-copy-option"
												disabled={!canAssign || copyPickerBusy}
												onclick={() => pickCopy(a.id, copy, entry.id)}
											>
												<span class="mono">
													{copy.setCode.toUpperCase()} #{copy.collectorNumber}
													{#if copy.foil}<span class="text-muted" style="font-size:10px">
															F</span
														>{/if}
													{#if isCurrent}<span style="color:var(--accent)"> ✓</span>{/if}
												</span>
												<span
													style="color:{copy.available > 0 ? 'var(--text-muted)' : 'var(--danger)'}"
												>
													{copy.available}/{copy.quantity}
												</span>
											</button>
										{/if}
									{/each}
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/each}

{#if data.unlinkedAssignments.length > 0}
	<div class="card mt-2">
		<div style="font-weight:600;margin-bottom:8px">Proxy assignments</div>
		{#each data.unlinkedAssignments as a}
			{@const displayStatus = a.status}
			<div class="flex gap-2 mb-1" style="align-items:center;font-size:13px">
				<span class="badge {STATUS_CLASSES[displayStatus]}"
					>{STATUS_ICONS[displayStatus]} {displayStatus}</span
				>
				<a href="/decks/{a.deckId}" style="font-weight:500">{a.deckName}</a>
			</div>
		{/each}
	</div>
{/if}

{#if copyPickerId !== null}
	<div
		class="assignment-copy-overlay"
		onclick={() => (copyPickerId = null)}
		onkeydown={(event) => {
			if (event.key === 'Escape') copyPickerId = null;
		}}
		role="presentation"
		aria-hidden="true"
	></div>
{/if}

<style>
	.card-assignment-row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
		font-size: 13px;
	}

	.assignment-printing-btn {
		margin-left: auto;
		padding: 2px 7px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface);
		color: var(--text-muted);
		font-size: 11px;
		cursor: pointer;
	}
	.assignment-printing-btn:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent);
	}
	.assignment-printing-btn:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.assignment-copy-overlay {
		position: fixed;
		inset: 0;
		z-index: 49;
	}

	.assignment-copy-picker {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 50;
		min-width: 250px;
		max-width: 340px;
		padding: 4px 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		box-shadow: 0 6px 20px color-mix(in srgb, var(--text) 18%, transparent);
	}

	.assignment-copy-header {
		margin-bottom: 2px;
		padding: 6px 12px 5px;
		border-bottom: 1px solid var(--border);
		color: var(--text-muted);
		font-size: 11px;
		font-weight: 700;
	}

	.assignment-copy-msg {
		padding: 8px 12px;
		color: var(--text-muted);
		font-size: 12px;
	}
	.assignment-copy-error {
		color: var(--danger);
	}

	.assignment-copy-option {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 5px 12px;
		border: 0;
		background: none;
		color: var(--text);
		cursor: pointer;
		font-size: 12px;
		text-align: left;
	}
	.assignment-copy-option:not(:disabled):hover {
		background: var(--surface-2);
	}
	.assignment-copy-option:disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}

	.assignment-copy-conflict {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin: 2px 6px 4px;
		padding: 7px 9px;
		border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border));
		border-radius: 5px;
		background: color-mix(in srgb, var(--warning) 5%, var(--surface));
		font-size: 11px;
	}
	.assignment-copy-conflict span:last-of-type {
		color: var(--text-muted);
		font-size: 10px;
		font-style: italic;
	}
	.assignment-copy-conflict-actions {
		display: flex;
		gap: 5px;
		margin-top: 3px;
	}
	.assignment-copy-conflict-btn {
		padding: 3px 7px;
		border: 1px solid transparent;
		border-radius: 3px;
		font-size: 10px;
		font-weight: 700;
		cursor: pointer;
	}
	.assignment-copy-conflict-btn--take {
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface));
		color: var(--accent);
	}
	.assignment-copy-conflict-btn--proxy {
		border-color: color-mix(in srgb, var(--proxy) 35%, transparent);
		background: color-mix(in srgb, var(--proxy) 10%, var(--surface));
		color: var(--proxy);
	}
</style>
