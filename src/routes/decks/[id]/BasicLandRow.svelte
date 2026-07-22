<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import { onDestroy } from 'svelte';
	import type { ManagerCard, ManagerCtx } from './manager-types';

	let { card }: { card: ManagerCard } = $props();
	const ctx = getContext<ManagerCtx>('manager');

	const total = $derived(card.assignments.length);
	const initialPulled = untrack(() => card.assignments.filter((a) => a.pulled).length);
	let pulled = $state(initialPulled);
	let inputVal = $state(String(initialPulled));
	let saving = $state(false);
	let dirty = $state(false);
	let menuOpen = $state(false);
	let deckMutationBusy = $state(false);
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let saveSeq = 0;

	// Keep local state in sync if parent data refreshes
	$effect(() => {
		const serverPulled = card.assignments.filter((a) => a.pulled).length;
		if (!dirty && !saving) {
			pulled = serverPulled;
			inputVal = String(serverPulled);
		}
	});

	onDestroy(() => {
		if (saveTimer) clearTimeout(saveTimer);
	});

	const allPulled = $derived(pulled >= total);

	function setPulled(n: number) {
		const clamped = Math.max(0, Math.min(total, n));
		if (clamped === pulled && inputVal === String(clamped)) return;
		pulled = clamped;
		inputVal = String(clamped);
		dirty = true;
		saving = true;

		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = null;
			void flushPulled(clamped);
		}, 180);
	}

	async function flushPulled(target: number) {
		const seq = ++saveSeq;
		try {
			const res = await fetch(`/api/deck-cards/${card.dcId}/pulled`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ count: target })
			});
			if (!res.ok) throw new Error('Failed to save basic land count');
			if (seq === saveSeq && pulled === target) {
				dirty = false;
				saving = false;
			}
		} catch {
			if (seq === saveSeq) {
				const serverPulled = card.assignments.filter((a) => a.pulled).length;
				pulled = serverPulled;
				inputVal = String(serverPulled);
				dirty = false;
				saving = false;
			}
		}
	}

	function onInput(e: Event) {
		inputVal = (e.target as HTMLInputElement).value;
	}

	function commitInput() {
		const n = parseInt(inputVal);
		if (!isNaN(n)) setPulled(n);
		else inputVal = String(pulled);
	}

	async function mutateCard(patch: {
		quantity?: number;
		board?: 'main' | 'side' | 'maybe' | 'commander';
	}) {
		if (deckMutationBusy) return;
		menuOpen = false;
		deckMutationBusy = true;
		try {
			await ctx.mutateDeckCard(card.dcId, patch);
		} finally {
			deckMutationBusy = false;
		}
	}
</script>

<div class="bl-row" class:bl-row--done={allPulled}>
	<!-- Qty col (blank — basics don't show qty separately) -->
	<span class="bl-qty"></span>

	<!-- Card name -->
	<span class="bl-name">{card.cardName}</span>

	<!-- Counter spans the icon + menu columns -->
	<div class="bl-counter">
		<button
			class="bl-btn"
			onclick={() => setPulled(pulled - 1)}
			disabled={pulled <= 0}
			aria-label="Remove one">−</button
		>
		<input
			class="bl-input"
			type="number"
			min="0"
			max={total}
			value={inputVal}
			oninput={onInput}
			onblur={commitInput}
			onkeydown={(e) => e.key === 'Enter' && commitInput()}
			aria-label="Pulled count"
		/>
		<span class="bl-total">/ {total}</span>
		<button
			class="bl-btn"
			onclick={() => setPulled(pulled + 1)}
			disabled={pulled >= total}
			aria-label="Add one">+</button
		>
	</div>
	{#if ctx.canEditDeck}
		<div class="bl-actions">
			<button class="bl-menu-btn" title="Card actions" onclick={() => (menuOpen = !menuOpen)}
				>⋯</button
			>
			{#if menuOpen}
				<div class="bl-menu-overlay" onclick={() => (menuOpen = false)} aria-hidden="true"></div>
				<div class="bl-menu">
					<button onclick={() => mutateCard({ quantity: card.quantity + 1 })}>Add copy</button>
					<button
						class="bl-menu-danger"
						onclick={() => mutateCard({ quantity: card.quantity - 1 })}
					>
						{card.quantity === 1 ? 'Remove from deck' : 'Remove one copy'}
					</button>
					{#if card.board !== 'main'}<button onclick={() => mutateCard({ board: 'main' })}
							>Move to Main</button
						>{/if}
					{#if card.board !== 'side'}<button onclick={() => mutateCard({ board: 'side' })}
							>Move to Sideboard</button
						>{/if}
					{#if card.board !== 'maybe'}<button onclick={() => mutateCard({ board: 'maybe' })}
							>Move to Maybeboard</button
						>{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* Align with ManagerRow 4-column grid: 28px | 1fr | 24px | 28px
	   Counter spans the last two columns (icon + menu area). */
	.bl-row {
		display: grid;
		grid-template-columns: 28px 1fr auto auto;
		align-items: center;
		gap: 0;
		padding: 5px 8px 5px 4px;
		min-height: 30px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
		border-left: 3px solid color-mix(in srgb, var(--border) 70%, transparent);
		transition: background 0.07s;
	}
	.bl-row:last-child {
		border-bottom: none;
	}
	.bl-row--done {
		border-left-color: var(--success);
		background: color-mix(in srgb, var(--success) 4%, var(--surface));
	}
	.bl-row:hover {
		background: color-mix(in srgb, var(--text) 3%, var(--surface));
	}

	/* Qty placeholder keeps alignment with ManagerRow */
	.bl-qty {
		width: 28px;
	}

	.bl-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bl-counter {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.bl-btn {
		width: 22px;
		height: 22px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface-2);
		color: var(--text);
		font-size: 14px;
		font-weight: 700;
		cursor: pointer;
		line-height: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.bl-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
		border-color: var(--accent);
	}
	.bl-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.bl-input {
		width: 36px;
		height: 22px;
		padding: 0 4px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface);
		color: var(--text);
		font-size: 12px;
		font-weight: 600;
		text-align: center;
	}
	/* hide number spinners */
	.bl-input::-webkit-inner-spin-button,
	.bl-input::-webkit-outer-spin-button {
		-webkit-appearance: none;
	}
	.bl-input {
		appearance: textfield;
		-moz-appearance: textfield;
	}

	.bl-total {
		font-size: 11px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.bl-actions {
		position: relative;
		margin-left: 3px;
	}
	.bl-menu-btn {
		width: 23px;
		height: 23px;
		border: 0;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		opacity: 0.4;
	}
	.bl-menu-btn:hover {
		opacity: 1;
		background: var(--surface-2);
	}
	.bl-menu-overlay {
		position: fixed;
		z-index: 79;
		inset: 0;
	}
	.bl-menu {
		position: absolute;
		z-index: 80;
		top: calc(100% + 3px);
		right: 0;
		min-width: 170px;
		padding: 4px 0;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--surface);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
	}
	.bl-menu button {
		display: block;
		width: 100%;
		padding: 6px 12px;
		border: 0;
		background: none;
		color: var(--text-muted);
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}
	.bl-menu button:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.bl-menu .bl-menu-danger {
		color: var(--danger);
	}
</style>
