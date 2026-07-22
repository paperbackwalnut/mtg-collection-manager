<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function pageHref(page: number): string {
		const params = new URLSearchParams();
		if (data.query) params.set('q', data.query);
		if (data.inCollectionOnly) params.set('owned', '1');
		if (page > 1) params.set('page', String(page));
		const query = params.toString();
		return `/oracle-tags${query ? `?${query}` : ''}`;
	}

	function collectionHref(label: string): string {
		const quoted = label.replace(/"/g, '\\"');
		return `/collection?q=${encodeURIComponent(`otag:"${quoted}"`)}`;
	}

	const unavailableMessage = 'No cards in your collection have this Oracle tag.';
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Oracle Tags</h1>
		<p class="page-subtitle">
			{#if data.directory.state === 'ready'}
				{data.directory.total.toLocaleString()} tag{data.directory.total === 1 ? '' : 's'}
				{data.inCollectionOnly ? ' represented in your collection' : ''}
			{:else}
				Scryfall card-function taxonomy
			{/if}
		</p>
	</div>
	<a href="/settings" class="btn">Tag settings</a>
</div>

{#if data.directory.state === 'missing_db'}
	<div class="empty-state">
		<h2>Local tag data unavailable</h2>
		<p class="text-muted text-sm">
			Use <a href="/settings">Settings</a> to refresh the local Oracle-tag cache.
		</p>
	</div>
{:else if data.directory.state === 'tags_missing'}
	<div class="empty-state">
		<h2>Oracle tags have not been imported</h2>
		<p class="text-muted text-sm">
			Use <a href="/settings">Settings</a> to refresh tags, or run <code>pnpm scryfall:tags</code>.
		</p>
	</div>
{:else}
	<form method="GET" class="filter-bar tag-filters">
		<input
			type="search"
			name="q"
			value={data.query}
			placeholder="Search Oracle tags..."
			aria-label="Search Oracle tags"
		/>
		<label class="owned-toggle">
			<input
				type="checkbox"
				name="owned"
				value="1"
				checked={data.inCollectionOnly}
				onchange={(event) => event.currentTarget.form?.requestSubmit()}
			/>
			<span>In collection only</span>
		</label>
		<button type="submit" class="btn">Search</button>
		{#if data.query || data.inCollectionOnly}
			<a href="/oracle-tags" class="btn">Clear</a>
		{/if}
	</form>

	{#if data.directory.entries.length === 0}
		<div class="empty-state">
			<p>No Oracle tags match these filters.</p>
		</div>
	{:else}
		<div class="tag-directory">
			<div class="tag-header" aria-hidden="true">
				<span>Oracle tag</span>
				<span>Description</span>
				<span>Collection</span>
			</div>
			{#each data.directory.entries as tag}
				<div class:tag-row--unavailable={tag.collectionCount === 0} class="tag-row">
					<div class="tag-name">
						{#if tag.collectionCount > 0}
							<a href={collectionHref(tag.label)}>{tag.label}</a>
						{:else}
							<span
								class="unavailable-tag"
								tabindex="0"
								role="link"
								aria-disabled="true"
								aria-label="{tag.label}. {unavailableMessage}"
								data-tooltip={unavailableMessage}>{tag.label}</span
							>
						{/if}
					</div>
					<div class="tag-description">{tag.description ?? 'No description provided.'}</div>
					<div class="tag-count">
						{#if tag.collectionCount > 0}
							{tag.collectionCount.toLocaleString()} match{tag.collectionCount === 1 ? '' : 'es'}
						{:else}
							None
						{/if}
					</div>
				</div>
			{/each}
		</div>

		{#if data.directory.total > data.directory.pageSize}
			<div class="pagination">
				<span>
					Showing {(data.directory.page - 1) * data.directory.pageSize + 1}-{Math.min(
						data.directory.page * data.directory.pageSize,
						data.directory.total
					)}
					of {data.directory.total.toLocaleString()}
				</span>
				<div>
					{#if data.directory.page > 1}
						<a href={pageHref(data.directory.page - 1)} class="btn btn-sm">Prev</a>
					{/if}
					{#if data.directory.page * data.directory.pageSize < data.directory.total}
						<a href={pageHref(data.directory.page + 1)} class="btn btn-sm">Next</a>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
{/if}

<style>
	.tag-filters {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.tag-filters input[type='search'] {
		width: min(360px, 100%);
	}
	.owned-toggle {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		min-height: 32px;
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}
	.owned-toggle input {
		width: 15px;
		height: 15px;
		accent-color: var(--accent);
	}
	.tag-directory {
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
	}
	.tag-header,
	.tag-row {
		display: grid;
		grid-template-columns: minmax(180px, 0.8fr) minmax(280px, 2fr) 110px;
		column-gap: 18px;
		align-items: center;
	}
	.tag-header {
		padding: 7px 10px;
		background: var(--surface-2);
		color: var(--text-muted);
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
	}
	.tag-row {
		min-height: 48px;
		padding: 7px 10px;
		border-top: 1px solid var(--border);
	}
	.tag-header + .tag-row {
		border-top: 0;
	}
	.tag-row:hover {
		background: color-mix(in srgb, var(--accent) 3%, transparent);
	}
	.tag-name {
		min-width: 0;
		font-size: 13px;
		font-weight: 650;
	}
	.tag-name a {
		color: var(--accent);
		text-decoration: none;
	}
	.tag-name a:hover {
		text-decoration: underline;
	}
	.tag-description {
		min-width: 0;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.35;
	}
	.tag-count {
		color: var(--text-muted);
		font-size: 11px;
		text-align: right;
		white-space: nowrap;
	}
	.tag-row--unavailable {
		color: var(--text-muted);
	}
	.unavailable-tag {
		position: relative;
		display: inline-block;
		color: var(--text-muted);
		cursor: help;
		outline: none;
	}
	.unavailable-tag:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
	}
	.unavailable-tag::after {
		position: absolute;
		z-index: 10;
		left: 0;
		bottom: calc(100% + 7px);
		width: max-content;
		max-width: 260px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface);
		box-shadow: var(--shadow-sm);
		color: var(--text);
		content: attr(data-tooltip);
		font-size: 11px;
		font-weight: 400;
		line-height: 1.35;
		opacity: 0;
		pointer-events: none;
		transform: translateY(2px);
		transition:
			opacity 120ms ease,
			transform 120ms ease;
	}
	.unavailable-tag:hover::after,
	.unavailable-tag:focus-visible::after {
		opacity: 1;
		transform: translateY(0);
	}
	.pagination {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 0;
		color: var(--text-muted);
		font-size: 12px;
	}
	.pagination > div {
		display: flex;
		gap: 6px;
		margin-left: auto;
	}
	@media (max-width: 720px) {
		.tag-filters {
			flex-wrap: wrap;
		}
		.tag-filters input[type='search'] {
			flex: 1 1 100%;
		}
		.tag-header {
			display: none;
		}
		.tag-row {
			grid-template-columns: 1fr auto;
			gap: 4px 12px;
			padding: 10px 4px;
		}
		.tag-description {
			grid-column: 1 / -1;
		}
		.tag-count {
			grid-column: 2;
			grid-row: 1;
		}
	}
</style>
