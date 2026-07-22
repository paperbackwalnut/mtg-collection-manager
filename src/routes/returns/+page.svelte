<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	import type { ReturnQueueCopy, ReturnQueueTask } from './+page.server';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let selected = $state(new Set<number>());
	let bulkBusy = $state(false);

	const allTasks = $derived(data.groups.flatMap((group) => group.tasks));
	const selectedTasks = $derived(allTasks.filter((task) => selected.has(task.id)));
	const allSelected = $derived(allTasks.length > 0 && selected.size === allTasks.length);

	$effect(() => {
		const validIds = new Set(allTasks.map((task) => task.id));
		const next = new Set([...selected].filter((id) => validIds.has(id)));
		if (next.size !== selected.size) selected = next;
	});

	function toggleTask(id: number) {
		const next = new Set(selected);
		next.has(id) ? next.delete(id) : next.add(id);
		selected = next;
	}

	function toggleAll() {
		selected = allSelected ? new Set() : new Set(allTasks.map((task) => task.id));
	}

	function kindLabel(kind: ReturnQueueCopy['kind']) {
		if (kind === 'owned') return 'Owned';
		if (kind === 'proxy') return 'Printed proxy';
		return 'Card';
	}

	function destinationSummary(task: ReturnQueueTask) {
		const labels = [...new Set(task.copies.map((copy) => copy.destinationLabel))];
		if (labels.length === 0) return 'Destination unavailable';
		return labels.length === 1 ? labels[0] : labels.join(' · ');
	}
</script>

<svelte:head>
	<title>Return to collection · MTG Collection Manager</title>
</svelte:head>

<div class="page-header returns-header">
	<div>
		<h1 class="page-title">Return to collection</h1>
		<p class="page-subtitle">
			{#if data.taskCount > 0}
				{data.copyCount}
				{data.copyCount === 1 ? 'copy' : 'copies'} from
				{data.taskCount}
				{data.taskCount === 1 ? 'card' : 'cards'}
				across {data.groups.length}
				{data.groups.length === 1 ? 'deck' : 'decks'}
			{:else}
				No packed cards are waiting to be returned
			{/if}
		</p>
	</div>

	<a href="/help#returns" class="btn btn-sm">How this works</a>

	{#if data.taskCount > 0}
		<div class="returns-header-actions">
			<label class="returns-select-all">
				<input type="checkbox" checked={allSelected} onchange={toggleAll} />
				<span>Select all</span>
			</label>
			{#if selectedTasks.length > 0}
				<form
					method="POST"
					action="?/complete"
					use:enhance={() => {
						bulkBusy = true;
						return async ({ update }) => {
							try {
								await update();
								selected = new Set();
							} finally {
								bulkBusy = false;
							}
						};
					}}
				>
					{#each selectedTasks as task}
						<input type="hidden" name="task" value="{task.deckId}:{task.id}" />
					{/each}
					<button class="btn btn-primary" type="submit" disabled={bulkBusy}>
						{bulkBusy ? 'Returning…' : `Returned (${selectedTasks.length})`}
					</button>
				</form>
			{/if}
		</div>
	{/if}
</div>

{#if form?.error}
	<div class="alert alert-error" role="alert">{form.error}</div>
{:else if form?.completed}
	<div class="alert alert-success" role="status">
		Completed {form.completed}
		{form.completed === 1 ? 'return' : 'returns'}.
	</div>
{/if}

{#if data.taskCount === 0}
	<div class="returns-empty">
		<strong>Nothing to put away.</strong>
		<span>New return tasks will appear after a Moxfield sync removes packed cards.</span>
	</div>
{:else}
	<div class="returns-groups">
		{#each data.groups as group}
			<section class="returns-group">
				<header class="returns-group-header">
					<a href="/decks/{group.deckId}">{group.deckName}</a>
					<span>{group.copyCount} {group.copyCount === 1 ? 'copy' : 'copies'}</span>
				</header>

				<div class="returns-list">
					{#each group.tasks as task}
						<article class="return-row" class:return-row--selected={selected.has(task.id)}>
							<label class="return-select">
								<input
									type="checkbox"
									checked={selected.has(task.id)}
									onchange={() => toggleTask(task.id)}
									aria-label="Select {task.cardName}"
								/>
							</label>

							<div class="return-image">
								{#if task.imageUri}
									<img src={task.imageUri} alt="" loading="lazy" />
								{/if}
							</div>

							<div class="return-main">
								<div class="return-title">
									<a href="/cards/{encodeURIComponent(task.cardName)}">{task.cardName}</a>
									{#if task.copies.length > 1}
										<span>×{task.copies.length}</span>
									{/if}
								</div>
								<div class="return-destination">
									Return to <strong>{destinationSummary(task)}</strong>
								</div>
								{#if task.copies.length > 0}
									<div class="return-copies">
										{#each task.copies as copy}
											<span>
												{kindLabel(copy.kind)}
												{#if copy.printing}
													· {copy.printing}{/if}
												{#if task.copies.length > 1}
													· {copy.destinationLabel}{/if}
											</span>
										{/each}
									</div>
								{:else}
									<div class="return-copies">
										<span>Legacy return task · sync this deck again for exact copy detail</span>
									</div>
								{/if}
							</div>

							<div class="return-actions">
								<a class="btn btn-sm" href="/decks/{task.deckId}">Open deck</a>
								<form method="POST" action="?/complete" use:enhance>
									<input type="hidden" name="task" value="{task.deckId}:{task.id}" />
									<button class="btn btn-sm btn-danger" type="submit">Returned</button>
								</form>
							</div>
						</article>
					{/each}
				</div>
			</section>
		{/each}
	</div>
{/if}

<style>
	.returns-header {
		align-items: flex-end;
	}
	.returns-header-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.returns-header-actions form,
	.return-actions form {
		display: inline;
	}
	.returns-select-all {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-muted);
		font-size: 12px;
		cursor: pointer;
	}
	.returns-select-all input,
	.return-select input {
		width: 14px;
		height: 14px;
		accent-color: var(--accent);
	}
	.returns-empty {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 32px 0;
		border-top: 1px solid var(--border);
		color: var(--text-muted);
	}
	.returns-empty strong {
		color: var(--text);
	}
	.returns-groups {
		border-top: 1px solid var(--border);
	}
	.returns-group {
		padding: 18px 0 8px;
		border-bottom: 1px solid var(--border);
	}
	.returns-group-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		padding: 0 4px 8px;
	}
	.returns-group-header a {
		color: var(--text);
		font-size: 14px;
		font-weight: 700;
		text-decoration: none;
	}
	.returns-group-header a:hover {
		color: var(--accent);
	}
	.returns-group-header span {
		color: var(--text-muted);
		font-size: 11px;
	}
	.returns-list {
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	.return-row {
		display: grid;
		grid-template-columns: 28px 46px minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		min-height: 76px;
		padding: 7px 10px;
		border-left: 3px solid var(--danger);
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.return-row:last-child {
		border-bottom: 0;
	}
	.return-row--selected {
		background: color-mix(in srgb, var(--accent) 6%, var(--surface));
	}
	.return-select {
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.return-image {
		width: 40px;
		aspect-ratio: 63 / 88;
		overflow: hidden;
		border-radius: 4px;
		background: var(--surface-raised);
	}
	.return-image img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.return-main {
		min-width: 0;
	}
	.return-title {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
	}
	.return-title a {
		overflow: hidden;
		color: var(--text);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.return-title a:hover {
		color: var(--accent);
	}
	.return-title span {
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: 11px;
	}
	.return-destination {
		margin-top: 3px;
		color: var(--text-muted);
		font-size: 12px;
	}
	.return-destination strong {
		color: var(--success);
		font-weight: 700;
	}
	.return-copies {
		display: flex;
		gap: 4px 12px;
		flex-wrap: wrap;
		margin-top: 3px;
		color: var(--text-muted);
		font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
		font-size: 10px;
	}
	.return-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}

	@media (max-width: 700px) {
		.returns-header {
			align-items: flex-start;
		}
		.return-row {
			grid-template-columns: 24px 40px minmax(0, 1fr);
			gap: 8px;
		}
		.return-actions {
			grid-column: 2 / -1;
			justify-content: flex-end;
			padding-top: 2px;
		}
	}
</style>
