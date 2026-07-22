<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function formatDate(ts: number) {
		return new Date(ts).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}
</script>

<div class="page-header">
	<div>
		<h1 class="page-title">Archive</h1>
		<p class="page-subtitle">
			{data.decks.length} archived deck{data.decks.length !== 1 ? 's' : ''}
		</p>
	</div>
	<a href="/decks" class="btn btn-sm">← Decks</a>
</div>

{#if data.decks.length === 0}
	<div class="empty-state">
		<p>No archived decks.</p>
		<p class="text-muted text-sm" style="margin-top:6px">
			Use the Archive button on a deck to remove it from your active list and unassign its cards.
		</p>
	</div>
{:else}
	<table class="data-table">
		<thead>
			<tr>
				<th>Deck</th>
				<th>Format</th>
				<th>Commander</th>
				<th>Cards</th>
				<th>Archived</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each data.decks as deck}
				<tr>
					<td style="font-weight:600">{deck.name}</td>
					<td style="color:var(--text-muted);font-size:12px">{deck.format ?? '—'}</td>
					<td style="color:var(--text-muted);font-size:12px">{deck.commander ?? '—'}</td>
					<td style="font-size:13px">{deck.mainCardCount}</td>
					<td style="font-size:11px;color:var(--text-muted);white-space:nowrap">
						{deck.archivedAt ? formatDate(deck.archivedAt) : '—'}
					</td>
					<td>
						<div style="display:flex;gap:6px;white-space:nowrap">
							<a href="/decks/{deck.id}" class="act-chip" style="font-size:11px">View</a>
							<form
								method="POST"
								action="/decks/{deck.id}?/restoreDeck"
								use:enhance
								style="display:inline"
							>
								<button
									type="submit"
									class="act-chip"
									style="font-size:11px;color:var(--success);border-color:color-mix(in srgb,var(--success) 40%,transparent)"
								>
									Restore
								</button>
							</form>
						</div>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
