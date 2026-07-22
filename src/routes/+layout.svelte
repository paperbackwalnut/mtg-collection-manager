<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import type { LayoutData } from './$types';

	let { children, data }: { children: any; data: LayoutData } = $props();

	let navOpen = $state(false);
	let theme = $state<'dark' | 'light'>('dark');
	let sidebarCollapsed = $state(false);

	// ── Nav structure ─────────────────────────────────────────────────────
	const navGroups = [
		{ section: 'Main', items: [{ href: '/', label: 'Dashboard', abbr: 'Ds', exact: true }] },
		{
			section: 'Library',
			items: [
				{ href: '/collection', label: 'Collection', abbr: 'Co', exact: true },
				{ href: '/collection/import', label: 'Import', abbr: 'Im', exact: false },
				{ href: '/collection/scryfall', label: 'Scryfall Cache', abbr: 'Sc', exact: false },
				{ href: '/decks', label: 'Decks', abbr: 'De', exact: false },
				{ href: '/archive', label: 'Archive', abbr: 'Ar', exact: false }
			]
		},
		{
			section: 'Tools',
			items: [
				{ href: '/missing', label: 'Missing', abbr: 'Mi', exact: false },
				{ href: '/shortfalls', label: 'Shortfalls', abbr: 'Sf', exact: false },
				{ href: '/shopping-list', label: 'Shopping List', abbr: 'SL', exact: false },
				{ href: '/picklist', label: 'Pick List', abbr: 'PL', exact: false },
				{ href: '/returns', label: 'Returns', abbr: 'Rt', exact: false },
				{ href: '/proxies', label: 'Proxies', abbr: 'Pr', exact: false },
				{ href: '/orders', label: 'Orders', abbr: 'Or', exact: false },
				{ href: '/oracle-tags', label: 'Oracle Tags', abbr: 'OT', exact: false }
			]
		},
		{
			section: 'System',
			items: [
				{ href: '/help', label: 'Help', abbr: 'He', exact: false },
				{ href: '/settings', label: 'Settings', abbr: 'St', exact: false }
			]
		}
	];

	// Enrichment banner state
	let enrichDismissed = $state(false);
	let enriching = $state(false);
	let enrichResult = $state<{ enriched: number; notFound: number; error?: string } | null>(null);

	// Scryfall staleness banner state
	let scryfallDismissed = $state(false);
	let scryfallRefreshing = $state(false);
	let scryfallRefreshResult = $state<{ updated: number; error?: string } | null>(null);

	$effect(() => {
		// Sync with the attribute already set by the flash-prevention script
		const stored = localStorage.getItem('theme') as 'dark' | 'light' | null;
		if (stored) {
			theme = stored;
		} else {
			theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
		}
		// Read sidebar collapsed state
		sidebarCollapsed = localStorage.getItem('sidebarCollapsed') === '1';
	});

	$effect(() => {
		// Restore dismiss states from sessionStorage (resets on browser close)
		if (sessionStorage.getItem('enrichDismissed') === '1') enrichDismissed = true;
		if (sessionStorage.getItem('scryfallDismissed') === '1') scryfallDismissed = true;
	});

	$effect(() => {
		document.documentElement.setAttribute('data-theme', theme);
		localStorage.setItem('theme', theme);
	});

	$effect(() => {
		localStorage.setItem('sidebarCollapsed', sidebarCollapsed ? '1' : '0');
	});

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
	}

	function closeNav() {
		navOpen = false;
	}

	function toggleSidebar() {
		sidebarCollapsed = !sidebarCollapsed;
	}

	function isActive(path: string) {
		return page.url.pathname === path || page.url.pathname.startsWith(path + '/');
	}

	function dismissEnrich() {
		enrichDismissed = true;
		sessionStorage.setItem('enrichDismissed', '1');
	}

	function dismissScryfall() {
		scryfallDismissed = true;
		sessionStorage.setItem('scryfallDismissed', '1');
	}

	async function runEnrich() {
		enriching = true;
		enrichResult = null;
		try {
			const res = await fetch('/api/enrich', { method: 'POST' });
			const json = await res.json();
			enrichResult = json;
			if (!json.error) {
				await invalidateAll();
			}
		} catch (e) {
			enrichResult = { enriched: 0, notFound: 0, error: String(e) };
		} finally {
			enriching = false;
		}
	}

	async function runScryfallRefresh() {
		scryfallRefreshing = true;
		scryfallRefreshResult = null;
		try {
			const res = await fetch('/api/scryfall/refresh', { method: 'POST' });
			const json = await res.json();
			scryfallRefreshResult = json;
			if (!json.error) {
				await invalidateAll();
			}
		} catch (e) {
			scryfallRefreshResult = { updated: 0, error: String(e) };
		} finally {
			scryfallRefreshing = false;
		}
	}

	function formatAge(ms: number | null): string {
		if (!ms) return 'never';
		const days = Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
		if (days === 0) return 'today';
		if (days === 1) return 'yesterday';
		return `${days} days ago`;
	}
</script>

<svelte:head>
	<title>MTG Collection Manager</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<!-- Mobile nav backdrop -->
<div class="nav-backdrop" class:open={navOpen} onclick={closeNav} role="presentation"></div>

<div class="app-shell" class:nav-collapsed={sidebarCollapsed}>
	<header class="app-header">
		<button class="hamburger" onclick={() => (navOpen = !navOpen)} aria-label="Toggle navigation">
			{navOpen ? '✕' : '☰'}
		</button>
		<div class="catalog-label">
			<span class="catalog-tag">MTG</span>
			<span class="catalog-name">Collection Manager</span>
		</div>
		<button class="theme-btn" onclick={toggleTheme}>
			{theme === 'dark' ? 'Light' : 'Dark'}
		</button>
	</header>

	<nav class="app-nav" class:open={navOpen}>
		{#each navGroups as group}
			<div class="nav-section">{group.section}</div>
			{#each group.items as item}
				<a
					href={item.href}
					class:active={item.exact ? page.url.pathname === item.href : isActive(item.href)}
					onclick={closeNav}
					title={item.label}
				>
					<span class="nav-label">{item.label}</span>
					<span class="nav-abbrev" aria-hidden="true">{item.abbr}</span>
				</a>
			{/each}
		{/each}
		<div class="nav-toggle-wrap">
			<button
				class="nav-toggle"
				onclick={toggleSidebar}
				title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				>{sidebarCollapsed ? '›' : '‹'}</button
			>
		</div>
	</nav>

	<main class="app-main">
		<!-- Enrichment scanner banner -->
		{#if data.unenrichedCount > 0 && !enrichDismissed && enrichResult === null}
			<div class="enrich-banner">
				<span class="enrich-banner-msg">
					<strong>{data.unenrichedCount.toLocaleString()} cards</strong> are missing Scryfall data (type,
					price, images). Card locations and deck views may be incomplete.
				</span>
				<button class="enrich-banner-btn" onclick={runEnrich} disabled={enriching}>
					{enriching ? 'Fetching…' : 'Enrich now'}
				</button>
				<button class="enrich-banner-dismiss" onclick={dismissEnrich} aria-label="Dismiss">✕</button
				>
			</div>
		{:else if enriching}
			<div class="enrich-banner enrich-banner--progress">
				<span class="enrich-banner-msg">
					Fetching Scryfall data in batches… this takes ~35 seconds for large collections.
					<em>Don't close the page.</em>
				</span>
			</div>
		{:else if enrichResult}
			{#if enrichResult.error}
				<div class="enrich-banner enrich-banner--error">
					<span class="enrich-banner-msg">Enrichment failed: {enrichResult.error}</span>
					<button
						class="enrich-banner-dismiss"
						onclick={() => (enrichResult = null)}
						aria-label="Dismiss">✕</button
					>
				</div>
			{:else}
				<div class="enrich-banner enrich-banner--success">
					<span class="enrich-banner-msg">
						Enriched <strong>{enrichResult.enriched}</strong> cards
						{enrichResult.notFound > 0 ? `(${enrichResult.notFound} not found in Scryfall)` : ''}.
					</span>
					<button
						class="enrich-banner-dismiss"
						onclick={() => (enrichResult = null)}
						aria-label="Dismiss">✕</button
					>
				</div>
			{/if}
		{/if}

		<!-- Scryfall staleness banner -->
		{#if data.scryfallStale && !scryfallDismissed && scryfallRefreshResult === null && !scryfallRefreshing}
			<div class="enrich-banner enrich-banner--stale">
				<span class="enrich-banner-msg">
					Scryfall data was last refreshed <strong>{formatAge(data.scryfallLastUpdated)}</strong>.
					Prices and card info may be out of date.
				</span>
				<button class="enrich-banner-btn enrich-banner-btn--stale" onclick={runScryfallRefresh}>
					Refresh now
				</button>
				<button class="enrich-banner-dismiss" onclick={dismissScryfall} aria-label="Dismiss"
					>✕</button
				>
			</div>
		{:else if scryfallRefreshing}
			<div class="enrich-banner enrich-banner--progress">
				<span class="enrich-banner-msg">
					Refreshing Scryfall prices from bulk data… <em>Don't close the page.</em>
				</span>
			</div>
		{:else if scryfallRefreshResult}
			{#if scryfallRefreshResult.error}
				<div class="enrich-banner enrich-banner--error">
					<span class="enrich-banner-msg"
						>Scryfall refresh failed: {scryfallRefreshResult.error}</span
					>
					<button
						class="enrich-banner-dismiss"
						onclick={() => (scryfallRefreshResult = null)}
						aria-label="Dismiss">✕</button
					>
				</div>
			{:else}
				<div class="enrich-banner enrich-banner--success">
					<span class="enrich-banner-msg">
						Scryfall data refreshed — <strong>{scryfallRefreshResult.updated}</strong> cards updated.
					</span>
					<button
						class="enrich-banner-dismiss"
						onclick={() => (scryfallRefreshResult = null)}
						aria-label="Dismiss">✕</button
					>
				</div>
			{/if}
		{/if}

		{@render children()}
	</main>
</div>

<style>
	.enrich-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 14px;
		margin-bottom: 16px;
		border-radius: 6px;
		font-size: 13px;
		background: color-mix(in srgb, var(--warning) 10%, var(--surface));
		border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
		color: var(--text);
	}

	.enrich-banner--progress {
		background: color-mix(in srgb, var(--accent) 8%, var(--surface));
		border-color: color-mix(in srgb, var(--accent) 25%, transparent);
	}

	.enrich-banner--success {
		background: color-mix(in srgb, var(--success) 8%, var(--surface));
		border-color: color-mix(in srgb, var(--success) 25%, transparent);
	}

	.enrich-banner--error {
		background: color-mix(in srgb, var(--error) 8%, var(--surface));
		border-color: color-mix(in srgb, var(--error) 25%, transparent);
	}

	.enrich-banner--stale {
		background: color-mix(in srgb, var(--purple) 8%, var(--surface));
		border-color: color-mix(in srgb, var(--purple) 25%, transparent);
	}

	.enrich-banner-msg {
		flex: 1;
		line-height: 1.4;
	}

	.enrich-banner-btn {
		flex-shrink: 0;
		padding: 4px 11px;
		border-radius: 5px;
		border: 1px solid var(--border);
		background: var(--accent);
		color: #fff;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}

	.enrich-banner-btn--stale {
		background: var(--purple);
	}

	.enrich-banner-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.enrich-banner-dismiss {
		flex-shrink: 0;
		padding: 3px 7px;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-muted);
		font-size: 11px;
		cursor: pointer;
		line-height: 1;
	}

	.enrich-banner-dismiss:hover {
		background: var(--surface-raised);
	}
</style>
