<script lang="ts">
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';

	let { data }: { data: PageData } = $props();

	type S = (typeof data.decks)[0]['mainStats'];

	// notPulled = fulfilled cards still in storage (not yet in deck box)
	function notPulled(s: S): number {
		return (s.assigned ?? 0) + (s.proxied ?? 0) - (s.inDeck ?? 0);
	}

	// Deck is "ready" when everything is physically in the deck box
	// Deck is "complete" when all slots are fulfilled (no missing/unassigned)
	// Deck is "partial" when some slots have no fulfillment
	type Tier = 'ready' | 'complete' | 'partial' | 'empty';

	function tier(s: S, total: number): Tier {
		if (total === 0) return 'empty';
		const unfulfilled = (s.unassigned ?? 0) + (s.needed ?? 0) + (s.ordered ?? 0);
		if ((s.inDeck ?? 0) >= total) return 'ready';
		if (unfulfilled === 0) return 'complete';
		return 'partial';
	}

	const TIER_ORDER: Record<Tier, number> = { partial: 0, empty: 1, complete: 2, ready: 3 };

	const sortedDecks = $derived(
		[...data.decks].sort((a, b) => {
			const ta = tier(a.mainStats, a.mainCardCount);
			const tb = tier(b.mainStats, b.mainCardCount);
			if (ta !== tb) return TIER_ORDER[ta] - TIER_ORDER[tb];
			if (ta === 'partial') {
				const na = (a.mainStats.unassigned ?? 0) + (a.mainStats.needed ?? 0);
				const nb = (b.mainStats.unassigned ?? 0) + (b.mainStats.needed ?? 0);
				return nb - na;
			}
			return 0;
		})
	);

	const activeDecks = $derived(
		sortedDecks.filter((d) => tier(d.mainStats, d.mainCardCount) !== 'ready')
	);
	const readyDecks = $derived(
		sortedDecks.filter((d) => tier(d.mainStats, d.mainCardCount) === 'ready')
	);

	function formatDate(ts: number) {
		return new Date(ts).toLocaleDateString();
	}

	// ── Bulk sync ─────────────────────────────────────────────────────────────
	const moxfieldDecks = $derived(
		data.decks.filter((d) => d.moxfieldUrl && d.sourceMode === 'moxfield')
	);

	type BulkProgress = {
		total: number;
		current: number;
		deckName: string;
		succeeded: number;
		failed: Array<{ name: string; error: string }>;
		done: boolean;
	};

	let bulkProgress = $state<BulkProgress | null>(null);
	let cancelPending = $state(false);

	async function syncAllDecks() {
		if (moxfieldDecks.length === 0) return;
		cancelPending = false;
		bulkProgress = {
			total: moxfieldDecks.length,
			current: 0,
			deckName: '',
			succeeded: 0,
			failed: [],
			done: false
		};

		for (let i = 0; i < moxfieldDecks.length; i++) {
			if (cancelPending) break;
			const deck = moxfieldDecks[i];
			bulkProgress = { ...bulkProgress, current: i + 1, deckName: deck.name };
			try {
				const res = await fetch('/api/sync-deck', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ deckId: deck.id })
				});
				const json = await res.json();
				if (json.error)
					bulkProgress = {
						...bulkProgress,
						failed: [...bulkProgress.failed, { name: deck.name, error: json.error }]
					};
				else bulkProgress = { ...bulkProgress, succeeded: bulkProgress.succeeded + 1 };
			} catch (e) {
				bulkProgress = {
					...bulkProgress,
					failed: [...bulkProgress.failed, { name: deck.name, error: String(e) }]
				};
			}
			if (i < moxfieldDecks.length - 1 && !cancelPending)
				await new Promise<void>((r) => setTimeout(r, 300));
		}
		bulkProgress = { ...bulkProgress!, done: true };
		cancelPending = false;
		await invalidateAll();
	}

	function dismissBulk() {
		bulkProgress = null;
		cancelPending = false;
	}
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Decks</h1>
		<p class="page-subtitle">{data.decks.length} deck{data.decks.length !== 1 ? 's' : ''}</p>
	</div>
	<div style="display:flex;gap:8px;align-items:center">
		{#if moxfieldDecks.length > 0 && !bulkProgress}
			<button class="btn" onclick={syncAllDecks}>Sync all ({moxfieldDecks.length})</button>
		{/if}
		<a href="/decks/new" class="btn btn-primary">+ Import Deck</a>
	</div>
</div>

<!-- Bulk sync progress -->
{#if bulkProgress}
	{@const bp = bulkProgress}
	<div
		style="margin-bottom:16px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:5px"
	>
		{#if !bp.done}
			<div
				style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px"
			>
				<span style="font-size:13px;font-weight:600">Syncing {bp.current} of {bp.total}</span>
				{#if !cancelPending}
					<button
						class="btn btn-sm"
						style="color:var(--text-muted)"
						onclick={() => (cancelPending = true)}>Cancel after current</button
					>
				{:else}
					<span style="font-size:12px;color:var(--text-muted)">Cancelling…</span>
				{/if}
			</div>
			<div
				style="height:3px;background:var(--surface-2);border-radius:2px;margin-bottom:8px;overflow:hidden"
			>
				<div
					style="height:100%;width:{(bp.current / bp.total) *
						100}%;background:var(--accent);border-radius:2px;transition:width .3s"
				></div>
			</div>
			<div style="font-size:12px;color:var(--text-muted)">
				{#if bp.current > 0}{bp.deckName}…{/if}
			</div>
		{:else}
			<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
				<span style="font-size:13px;font-weight:600">
					Sync complete —
					{#if bp.succeeded > 0}<span style="color:var(--success)">{bp.succeeded} ok</span>{/if}
					{#if bp.failed.length > 0}<span style="color:var(--danger)">
							· {bp.failed.length} failed</span
						>{/if}
				</span>
				<button class="btn btn-sm" onclick={dismissBulk}>Dismiss</button>
			</div>
		{/if}
	</div>
{/if}

{#if data.decks.length === 0}
	<div class="empty-state">
		<p>No decks yet. <a href="/decks/new">Import your first deck →</a></p>
	</div>
{:else}
	<!-- Active decks -->
	{#if activeDecks.length > 0}
		<div class="deck-grid">
			{#each activeDecks as deck}
				{@const s = deck.mainStats}
				{@const total = deck.mainCardCount}
				{@const inDeck = s.inDeck ?? 0}
				{@const np = notPulled(s)}
				{@const unfulfilled = (s.unassigned ?? 0) + (s.needed ?? 0) + (s.ordered ?? 0)}
				{@const progress = total > 0 ? inDeck / total : 0}
				<a
					href="/decks/{deck.id}"
					class="deck-card"
					style={unfulfilled > 0
						? 'border-left:3px solid color-mix(in srgb,var(--warning) 55%,transparent);padding-left:10px'
						: ''}
				>
					<div
						style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:2px"
					>
						<span class="deck-name">{deck.name}</span>
						{#if unfulfilled > 0}
							<span style="font-size:11px;color:var(--warning);font-weight:600;flex-shrink:0"
								>{unfulfilled} unassigned</span
							>
						{/if}
					</div>
					<div class="deck-meta">
						{#if deck.format}{deck.format} ·
						{/if}{deck.commander ?? 'No commander'}
					</div>

					<!-- Primary: In Deck -->
					<div style="display:flex;align-items:baseline;gap:6px;margin:6px 0 3px">
						<span style="font-size:12px;color:var(--text-muted)">In Deck</span>
						<span style="font-size:15px;font-weight:700;color:var(--success)">{inDeck}</span>
						<span style="font-size:12px;color:var(--text-muted)">/ {total}</span>
					</div>
					<div
						style="height:3px;background:var(--surface-2);border-radius:2px;margin-bottom:6px;overflow:hidden"
					>
						<div
							style="height:100%;width:{progress *
								100}%;background:var(--success);border-radius:2px;transition:width .3s"
						></div>
					</div>

					<!-- Source breakdown (non-zero only) -->
					<div style="font-size:11px;display:flex;gap:8px;flex-wrap:wrap;margin-bottom:3px">
						{#if (s.assigned ?? 0) > 0}<span style="color:var(--assigned)">Real {s.assigned}</span
							>{/if}
						{#if (s.proxied ?? 0) > 0}<span style="color:var(--proxy)">Proxy {s.proxied}</span>{/if}
					</div>

					<!-- Warning counts (non-zero only) -->
					<div style="font-size:11px;display:flex;gap:8px;flex-wrap:wrap">
						{#if np > 0}<span style="color:var(--text-muted)">{np} not pulled</span>{/if}
						{#if (s.needsPrint ?? 0) > 0}<span style="color:var(--warning)"
								>{s.needsPrint} needs print</span
							>{/if}
						{#if (s.needed ?? 0) > 0}<span style="color:var(--danger)">{s.needed} missing</span
							>{/if}
						{#if (s.unassigned ?? 0) > 0}<span style="color:var(--text-muted)"
								>{s.unassigned} unassigned</span
							>{/if}
						{#if (s.ordered ?? 0) > 0}<span style="color:var(--assigned)">{s.ordered} ordered</span
							>{/if}
					</div>

					<div style="font-size:11px;color:var(--text-muted);margin-top:5px">
						{total} main{deck.sideCardCount > 0 ? ` · ${deck.sideCardCount} side` : ''}
						{#if (s.maybeCount ?? 0) > 0}<span style="opacity:0.5">
								· {s.maybeCount} maybe</span
							>{/if}
						· {formatDate(deck.updatedAt)}
					</div>
				</a>
			{/each}
		</div>
	{/if}

	<!-- Ready decks (all physically in deck box) -->
	{#if readyDecks.length > 0}
		<div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border)">
			<div
				style="font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px"
			>
				All in deck ({readyDecks.length})
			</div>
			<div class="deck-grid">
				{#each readyDecks as deck}
					{@const s = deck.mainStats}
					{@const total = deck.mainCardCount}
					<a href="/decks/{deck.id}" class="deck-card deck-card--ready">
						<div
							style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:2px"
						>
							<span class="deck-name">{deck.name}</span>
							<span style="font-size:10px;color:var(--success);font-weight:600;flex-shrink:0"
								>✓ All in deck</span
							>
						</div>
						<div class="deck-meta">
							{#if deck.format}{deck.format} ·
							{/if}{deck.commander ?? 'No commander'}
						</div>
						<div
							style="height:3px;background:color-mix(in srgb,var(--success) 30%,var(--surface-2));border-radius:2px;margin:7px 0 4px"
						></div>
						<div style="font-size:11px;display:flex;gap:8px;flex-wrap:wrap">
							{#if (s.assigned ?? 0) > 0}<span style="color:var(--assigned)">Real {s.assigned}</span
								>{/if}
							{#if (s.proxied ?? 0) > 0}<span style="color:var(--proxy)">Proxy {s.proxied}</span
								>{/if}
							{#if (s.needsPrint ?? 0) > 0}<span style="color:var(--warning)"
									>{s.needsPrint} needs print</span
								>{/if}
						</div>
						<div style="font-size:11px;color:var(--text-muted);margin-top:4px">
							{total} main · {formatDate(deck.updatedAt)}
						</div>
					</a>
				{/each}
			</div>
		</div>
	{/if}
{/if}
