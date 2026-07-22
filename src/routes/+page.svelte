<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	type S = (typeof data.decks)[0]['deckStats'];

	// notPulled = fulfilled cards still in storage
	function notPulled(s: S): number {
		return (s.assigned ?? 0) + (s.proxied ?? 0) - (s.inDeck ?? 0);
	}

	// Tier based purely on physical + fulfillment state
	type Tier = 'ready' | 'accounted' | 'partial' | 'empty';

	function tier(s: S, total: number): Tier {
		if (total === 0) return 'empty';
		const unfulfilled = (s.unassigned ?? 0) + (s.needed ?? 0) + (s.ordered ?? 0);
		if ((s.inDeck ?? 0) >= total) return 'ready'; // all physically in deck
		if (unfulfilled === 0) return 'accounted'; // all slots filled, not all pulled
		return 'partial'; // some slots still missing
	}

	const TIER_ORDER: Record<Tier, number> = { partial: 0, empty: 1, accounted: 2, ready: 3 };

	const sortedDecks = $derived(
		[...data.decks].sort((a, b) => {
			const ta = tier(a.deckStats, a.mainCardCount);
			const tb = tier(b.deckStats, b.mainCardCount);
			if (ta !== tb) return TIER_ORDER[ta] - TIER_ORDER[tb];
			if (ta === 'partial') {
				const na = (a.deckStats.unassigned ?? 0) + (a.deckStats.needed ?? 0);
				const nb = (b.deckStats.unassigned ?? 0) + (b.deckStats.needed ?? 0);
				return nb - na;
			}
			return 0;
		})
	);

	const activeDecks = $derived(
		sortedDecks.filter((d) => tier(d.deckStats, d.mainCardCount) !== 'ready')
	);
	const readyDecks = $derived(
		sortedDecks.filter((d) => tier(d.deckStats, d.mainCardCount) === 'ready')
	);
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Dashboard</h1>
		<p class="page-subtitle">
			{data.stats.collectionEntries.toLocaleString()} cards · {data.stats.deckCount} deck{data.stats
				.deckCount !== 1
				? 's'
				: ''}
			{#if data.stats.totalInDeck > 0}
				· <strong style="color:var(--success)"
					>{data.stats.totalInDeck.toLocaleString()} in deck</strong
				>
			{/if}
			{#if data.stats.totalNeeded > 0}
				· <strong style="color:var(--warning)"
					>{data.stats.totalNeeded.toLocaleString()} needed</strong
				>
			{/if}
		</p>
	</div>
	<div class="flex gap-2">
		<a href="/collection/import" class="btn btn-primary">+ Import Collection</a>
		<a href="/decks/new" class="btn">+ New Deck</a>
	</div>
</div>

<div class="card mb-2">
	<h2 style="margin:0 0 10px;font-size:15px">Access this app</h2>
	{#if data.access.lanEnabled}
		{#if data.access.lanUrls.length > 0}
			<p style="margin:0 0 12px;font-size:13px">
				On a phone or tablet connected to the same Wi-Fi, scan a code or open its address.
			</p>
			<div style="display:flex;flex-wrap:wrap;gap:16px">
				{#each data.access.lanUrls as access}
					<div style="display:grid;gap:8px;justify-items:center">
						<img
							src={access.qrDataUrl}
							alt="QR code for {access.url}"
							width="180"
							height="180"
							style="border-radius:8px;background:white"
						/>
						<a href={access.url} style="font-size:13px;font-weight:600">{access.url}</a>
					</div>
				{/each}
			</div>
		{:else}
			<p class="text-muted" style="margin:0;font-size:13px">
				LAN mode is on, but no active local-network address was detected.
			</p>
		{/if}
		<div
			style="margin-top:12px;padding:10px;border-radius:6px;background:color-mix(in srgb,var(--warning) 10%,transparent);font-size:12px"
		>
			<strong>Trusted networks only.</strong> This app has no login. Anyone who can reach this address
			can change its data. Do not configure router port forwarding or expose it to the public internet.
		</div>
	{:else}
		<p style="margin:0;font-size:13px">
			Available only on this computer at <a href={data.access.localUrl}>{data.access.localUrl}</a>.
		</p>
		<p class="text-muted" style="margin:7px 0 0;font-size:12px">
			To connect a phone or tablet on the same Wi-Fi, stop this launcher and use
			<code>start-lan.bat</code> on Windows or <code>sh start-lan.sh</code> on macOS/Linux.
		</p>
	{/if}
</div>

{#if data.stats.collectionEntries === 0 || data.scryfallTotal === 0}
	<div class="card mb-2">
		<h2 style="margin:0 0 10px;font-size:15px">First-run setup</h2>
		<div style="display:grid;gap:10px;font-size:13px">
			<div>
				<strong style="color:var(--success)">✓ Collection database ready</strong>
				<div class="text-muted">Personal data stays in your local collection.db file.</div>
			</div>
			<div>
				<strong style="color:{data.scryfallTotal > 0 ? 'var(--success)' : 'var(--warning)'}">
					{data.scryfallTotal > 0 ? '✓' : '2.'} Scryfall cache
				</strong>
				<div class="text-muted">
					{data.scryfallTotal > 0
						? `${data.scryfallTotal.toLocaleString()} card records cached locally.`
						: 'Download card metadata once for images, prices, search, and fast imports.'}
				</div>
				{#if data.scryfallTotal === 0}
					<a href="/collection/scryfall" class="btn btn-sm" style="margin-top:6px"
						>Set up Scryfall cache</a
					>
				{/if}
			</div>
			<div>
				<strong>{data.stats.collectionEntries > 0 ? '✓' : '3.'} Import your collection</strong>
				<div class="text-muted">
					Preview a Moxfield or Collection Manager CSV before applying it.
				</div>
				{#if data.stats.collectionEntries === 0}
					<a href="/collection/import" class="btn btn-sm" style="margin-top:6px"
						>Import collection</a
					>
				{/if}
			</div>
		</div>
	</div>
{/if}

{#if data.stats.collectionEntries === 0}
	<div class="empty-state">
		<p style="font-size:14px;font-weight:600;margin:0 0 6px;color:var(--text)">
			No collection imported yet
		</p>
		<p style="font-size:13px;margin:0 0 14px">
			Import a Moxfield collection CSV or a collection CSV previously exported by this app.
		</p>
		<a href="/collection/import" class="btn btn-primary">Import Collection CSV</a>
	</div>
{:else if data.stats.deckCount === 0}
	<div class="empty-state">
		<p style="font-size:14px;font-weight:600;margin:0 0 6px;color:var(--text)">No decks yet</p>
		<p style="font-size:13px;margin:0 0 14px">Import a decklist to start generating pick lists.</p>
		<a href="/decks/new" class="btn btn-primary">Import a Deck</a>
	</div>
{:else}
	{#if data.packedUnfulfilled.length > 0}
		<div class="packed-warning" role="status">
			<div class="packed-warning-header">
				<div>
					<strong
						>{data.packedUnfulfilled.length} packed card{data.packedUnfulfilled.length === 1
							? ''
							: 's'} need assignment review</strong
					>
					<p>These slots are marked packed but are not linked to a real printing or proxy.</p>
				</div>
				<a class="btn btn-sm" href="/picklist">Open Pick List</a>
			</div>
			<div class="packed-warning-list">
				{#each data.packedUnfulfilled as item}
					<a href="/decks/{item.deckId}" class="packed-warning-row">
						<span>{item.cardName}</span>
						<small>{item.deckName} · {item.board ?? 'main'} · {item.status}</small>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Active decks -->
	{#if activeDecks.length > 0}
		<div class="deck-grid">
			{#each activeDecks as deck}
				{@const s = deck.deckStats}
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
								>{unfulfilled} needed</span
							>
						{/if}
					</div>
					<div class="deck-meta">
						{deck.format ? deck.format + ' · ' : ''}{deck.commander ?? 'No commander'}
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
				</a>
			{/each}
		</div>
	{/if}

	<!-- Ready decks — all physically in deck box -->
	{#if readyDecks.length > 0}
		<div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border)">
			<div
				style="font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px"
			>
				All in deck ({readyDecks.length})
			</div>
			<div class="deck-grid">
				{#each readyDecks as deck}
					{@const s = deck.deckStats}
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
							{deck.format ? deck.format + ' · ' : ''}{deck.commander ?? 'No commander'}
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
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<div
		style="margin-top:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:13px"
	>
		<a href="/decks/new" style="color:var(--text-muted)">+ Import another deck</a>
		{#if data.stats.totalNeeded > 0}
			<span style="color:var(--text-muted)">
				<strong style="color:var(--warning)">{data.stats.totalNeeded.toLocaleString()}</strong>
				cards needed ·
				<a href="/missing">View missing →</a>
				· <a href="/picklist">Pick list →</a>
			</span>
		{/if}
	</div>
{/if}

<style>
	.packed-warning {
		margin-bottom: 14px;
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--border));
		border-left: 3px solid var(--danger);
		border-radius: 6px;
		background: color-mix(in srgb, var(--danger) 6%, var(--surface));
	}

	.packed-warning-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 8px;
	}

	.packed-warning-header strong {
		color: var(--text);
		font-size: 13px;
	}

	.packed-warning-header p {
		margin: 3px 0 0;
		color: var(--text-muted);
		font-size: 12px;
	}

	.packed-warning-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 4px 10px;
	}

	.packed-warning-row {
		display: flex;
		min-width: 0;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 0;
		color: var(--text);
		font-size: 12px;
		text-decoration: none;
	}

	.packed-warning-row:hover span {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.packed-warning-row span {
		overflow: hidden;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.packed-warning-row small {
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: 11px;
	}
</style>
