<script lang="ts">
	import ManagerRow from './ManagerRow.svelte';
	import ManagerCardRow from './ManagerCardRow.svelte';
	import BasicLandRow from './BasicLandRow.svelte';
	import type { ManagerGroupData } from './manager-types';
	import { isBasicLand } from '$lib/basics';

	let { group }: { group: ManagerGroupData } = $props();

	let collapsed = $state(false);
</script>

<!-- Type section card -->
<div class="mgr-group">
	<!-- Header: label + done/total + collapse toggle -->
	<button
		class="mgr-group-header"
		onclick={() => (collapsed = !collapsed)}
		aria-expanded={!collapsed}
	>
		<span class="mgr-group-label">{group.label}</span>
		<span class="mgr-group-count" class:mgr-group-count--done={group.done === group.total}>
			{group.done}/{group.total}
		</span>
		<span class="mgr-group-chevron" aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
	</button>

	{#if !collapsed}
		{#each group.items as { card }}
			{#if isBasicLand(card.cardName)}
				<!-- Basic lands use a simple pull counter instead of per-copy assignment rows -->
				<BasicLandRow {card} />
			{:else if card.assignments.length > 1}
				<ManagerCardRow {card} />
			{:else}
				{#each card.assignments as assignment, idx}
					<ManagerRow {card} {assignment} assignmentIdx={idx} />
				{/each}
			{/if}
		{/each}
	{/if}
</div>

<style>
	.mgr-group {
		break-inside: avoid;
		margin-bottom: 8px;
		/* overflow: visible (default) so absolutely-positioned dropdowns inside rows
		   can escape the container. Corner rounding is applied to header/last-row instead. */
		border: 1px solid color-mix(in srgb, var(--border) 90%, var(--text-muted));
		border-radius: 6px;
	}

	.mgr-group-header {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 5px 10px;
		/* Round the top corners to match the group's border-radius without overflow:hidden */
		border-radius: 5px 5px 0 0;
		background: var(--surface-raised);
		border: none;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 90%, var(--text-muted));
		cursor: pointer;
		text-align: left;
	}
	.mgr-group-header:hover {
		background: color-mix(in srgb, var(--accent) 7%, var(--surface-raised));
	}

	.mgr-group-label {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		flex: 1;
	}

	.mgr-group-count {
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.mgr-group-count--done {
		color: var(--success);
	}

	.mgr-group-chevron {
		font-size: 9px;
		color: var(--text-muted);
	}

	/* Round the last row's bottom corners to match group border-radius. */
	:global(.mgr-group .mgr-row:last-child) {
		border-radius: 0 0 5px 5px;
	}
</style>
