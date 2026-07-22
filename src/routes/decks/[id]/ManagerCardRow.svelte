<script lang="ts">
	import { getContext } from 'svelte';
	import ManagerRow from './ManagerRow.svelte';
	import type {
		ManagerAssignment,
		ManagerCard,
		ManagerCtx,
		ManagerPreviewCard
	} from './manager-types';

	let { card }: { card: ManagerCard } = $props();
	const ctx = getContext<ManagerCtx>('manager');

	let expanded = $state(false);
	let menuOpen = $state(false);
	let deckMutationBusy = $state(false);
	const boardOptions = [
		{ value: 'main', label: 'Main' },
		{ value: 'commander', label: 'Commander' },
		{ value: 'side', label: 'Sideboard' },
		{ value: 'maybe', label: 'Maybeboard' }
	] as const;
	const currentBoard = $derived((card.board ?? 'main') as (typeof boardOptions)[number]['value']);

	const assignmentIds = $derived(card.assignments.map((assignment) => assignment.id));
	const selectedCount = $derived(assignmentIds.filter((id) => ctx.selectedIds.has(id)).length);
	const allSelected = $derived(assignmentIds.length > 0 && selectedCount === assignmentIds.length);
	const anySelected = $derived(selectedCount > 0);

	function toggleAllSelected() {
		ctx.setSelected(assignmentIds, !allSelected);
	}

	function printingLabel(assignment: ManagerAssignment): string | null {
		if (assignment.collSetCode) {
			return `${assignment.collSetCode.toUpperCase()} #${assignment.collCollectorNumber}${assignment.collFoil ? ' F' : ''}`;
		}
		if (assignment.proxySetCode) {
			return `${assignment.proxySetCode.toUpperCase()} #${assignment.proxyCollectorNumber}`;
		}
		return null;
	}

	const printingSummary = $derived.by(() => {
		const labels = [...new Set(card.assignments.map(printingLabel).filter(Boolean))] as string[];
		if (labels.length === 0) return null;
		if (labels.length === 1) return labels[0];
		return `${labels[0]} +${labels.length - 1}`;
	});

	type BadgeInfo = {
		text: string;
		className: string;
		label: string;
	};

	function badgeFor(assignment: ManagerAssignment): BadgeInfo {
		const isPulled = assignment.pulled === true;
		const isReal = assignment.status === 'assigned';
		const isProxy = assignment.status === 'proxied';
		const presentedAsReal = isReal;
		const needsPrint =
			isProxy && assignment.printStatus === 'need_print' && assignment.proxyInventoryId === null;
		const needsReprint = isProxy && assignment.printStatus === 'need_reprint';
		const isNeeded = assignment.status === 'needed';
		const isNotOwned =
			(isNeeded || assignment.status === 'unassigned') && (card.collQty ?? 0) === 0;
		const isAllCopiesUsed =
			(isNeeded || assignment.status === 'unassigned') &&
			(card.collQty ?? 0) > 0 &&
			(card.availableQty ?? -1) === 0;
		const hasLinkedRealCopy = isReal && assignment.collectionId !== null;

		let text = '·';
		if (isNotOwned) text = 'X';
		else if (isAllCopiesUsed || isNeeded) text = 'i';
		else if (assignment.status === 'ordered') text = 'O';
		else if (presentedAsReal) text = '✓';
		else if (isProxy) text = needsReprint ? 'RP' : 'P';

		let className = 'mgr-card-badge--unassigned';
		if (isPulled && (needsPrint || needsReprint)) className = 'mgr-card-badge--print';
		else if (isPulled) className = 'mgr-card-badge--in-deck';
		else if (needsPrint || needsReprint) className = 'mgr-card-badge--print';
		else if (hasLinkedRealCopy || isProxy) className = 'mgr-card-badge--available';
		else if (isNotOwned) className = 'mgr-card-badge--not-owned';
		else if (isAllCopiesUsed || isNeeded) className = 'mgr-card-badge--info';
		else if (assignment.status === 'ordered') className = 'mgr-card-badge--ordered';

		let label = 'Unassigned';
		if (isPulled && presentedAsReal) label = 'In deck, real card';
		else if (isPulled && isProxy)
			label = needsReprint
				? 'In deck, proxy needs reprint'
				: needsPrint
					? 'In deck, proxy needs print'
					: 'In deck, proxy';
		else if (presentedAsReal) label = 'Assigned, not in deck';
		else if (needsReprint) label = 'Proxy needs reprint';
		else if (needsPrint) label = 'Proxy needs print';
		else if (isProxy) label = 'Proxy, not in deck';
		else if (isNotOwned) label = 'Not owned';
		else if (isAllCopiesUsed) label = 'All copies in use';
		else if (isNeeded) label = 'Needed';
		else if (assignment.status === 'ordered') label = 'Ordered';

		return { text, className, label };
	}

	const badges = $derived(card.assignments.map(badgeFor));
	const aggregateLabel = $derived(
		badges.map((badge, index) => `Copy ${index + 1}: ${badge.label}`).join('; ')
	);

	const rowClass = $derived.by(() => {
		const assignments = card.assignments;
		if ((card.syncReturnCount ?? 0) > 0) return 'mgr-card-row--return';
		if (assignments.every((assignment) => assignment.pulled)) return 'mgr-card-row--pulled';
		if (
			assignments.some(
				(assignment) =>
					(assignment.status === 'needed' || assignment.status === 'unassigned') &&
					(card.collQty ?? 0) === 0
			)
		)
			return 'mgr-card-row--missing';
		if (
			assignments.some(
				(assignment) =>
					assignment.status === 'proxied' &&
					((assignment.printStatus === 'need_print' && assignment.proxyInventoryId === null) ||
						assignment.printStatus === 'need_reprint')
			)
		)
			return 'mgr-card-row--needs-print';
		if (assignments.some((assignment) => assignment.pulled)) return 'mgr-card-row--pulled';
		if (assignments.some((assignment) => assignment.status === 'assigned')) {
			return 'mgr-card-row--assigned';
		}
		if (assignments.some((assignment) => assignment.status === 'proxied'))
			return 'mgr-card-row--proxied';
		if (assignments.some((assignment) => assignment.status === 'needed'))
			return 'mgr-card-row--needed';
		if (assignments.some((assignment) => assignment.status === 'ordered'))
			return 'mgr-card-row--ordered';
		return 'mgr-card-row--unassigned';
	});

	function updatePreview() {
		const assignment =
			card.assignments.find((candidate) => candidate.pulled) ?? card.assignments[0];
		const preview: ManagerPreviewCard = {
			name: card.cardName,
			imageUri: assignment?.imageUri ?? card.fallbackImageUri ?? null,
			printing: assignment ? printingLabel(assignment) : null
		};
		ctx.setPreviewCard(preview);
	}

	function openMenu(event: MouseEvent) {
		event.stopPropagation();
		menuOpen = !menuOpen;
	}

	async function mutateCard(patch: {
		quantity?: number;
		board?: (typeof boardOptions)[number]['value'];
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

<div class="mgr-card-block" class:mgr-card-block--expanded={expanded}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="mgr-card-row {rowClass}"
		class:mgr-card-row--selected={anySelected}
		onmouseenter={updatePreview}
		onfocusin={updatePreview}
	>
		<label
			class="mgr-card-check-col"
			class:mgr-card-check-col--visible={ctx.selectedIds.size > 0 || anySelected}
		>
			<input
				type="checkbox"
				class="mgr-card-check"
				checked={allSelected}
				indeterminate={anySelected && !allSelected}
				onchange={toggleAllSelected}
				aria-label="Select all {card.quantity} copies of {card.cardName}"
			/>
		</label>

		<span class="mgr-card-qty">{card.quantity}</span>

		<div class="mgr-card-name">
			<a
				href="/cards/{encodeURIComponent(card.cardName)}"
				class="card-link mgr-card-link"
				data-sveltekit-preload-data="off">{card.cardName}</a
			>
			{#if (card.syncAddedQuantity ?? 0) > 0}
				<span
					class="mgr-sync-badge mgr-sync-badge--added"
					title="{card.syncAddedQuantity} added by Moxfield sync"
					>NEW{card.syncAddedQuantity > 1 ? ` ×${card.syncAddedQuantity}` : ''}</span
				>
			{/if}
			{#if (card.syncReturnCount ?? 0) > 0}
				<span
					class="mgr-sync-badge mgr-sync-badge--return"
					title="{card.syncReturnCount} packed {card.syncReturnCount === 1
						? 'copy'
						: 'copies'} must be removed from this deck"
					>TAKE OUT{card.syncReturnCount > 1 ? ` ×${card.syncReturnCount}` : ''}</span
				>
			{/if}
			{#if printingSummary}
				<button
					class="mgr-card-printing"
					onclick={() => (expanded = true)}
					title="Show copy printings">{printingSummary}</button
				>
			{/if}
			{#if card.notes}
				<span class="mgr-card-note" title={card.notes}>N</span>
			{/if}
		</div>

		<button
			class="mgr-card-badges"
			onclick={() => (expanded = !expanded)}
			aria-expanded={expanded}
			aria-label={aggregateLabel}
			title={aggregateLabel}
		>
			{#each badges as badge}
				<span class="mgr-card-badge {badge.className}">{badge.text}</span>
			{/each}
		</button>

		<div class="mgr-card-actions">
			<button
				class="mgr-card-expand"
				onclick={() => (expanded = !expanded)}
				aria-expanded={expanded}
				aria-label={expanded
					? `Collapse copies of ${card.cardName}`
					: `Expand copies of ${card.cardName}`}
				title={expanded ? 'Collapse copies' : 'Expand copies'}>{expanded ? '▾' : '›'}</button
			>
			<button class="mgr-card-menu-btn" title="Card actions" onclick={openMenu}>⋯</button>

			{#if menuOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="mgr-card-menu-overlay"
					onclick={() => (menuOpen = false)}
					onkeydown={(event) => event.key === 'Escape' && (menuOpen = false)}
					aria-hidden="true"
				></div>
				<div class="mgr-card-menu">
					<button
						onclick={() => {
							expanded = !expanded;
							menuOpen = false;
						}}
					>
						{expanded ? 'Collapse copies' : 'Expand copies'}
					</button>
					<button
						onclick={() => {
							toggleAllSelected();
							menuOpen = false;
						}}
					>
						{allSelected ? 'Deselect all copies' : 'Select all copies'}
					</button>
					<button
						class:mgr-card-menu-note={!!card.notes}
						onclick={() => {
							menuOpen = false;
							ctx.openNoteModal(card.dcId, card.cardName, card.notes ?? '');
						}}>{card.notes ? 'Edit card note' : 'Add card note'}</button
					>
					{#if ctx.canEditDeck}
						<hr />
						<button
							disabled={deckMutationBusy}
							onclick={() => mutateCard({ quantity: card.quantity + 1 })}
						>
							Add copy
						</button>
						<button
							class="mgr-card-menu-danger"
							disabled={deckMutationBusy}
							onclick={() => mutateCard({ quantity: card.quantity - 1 })}
						>
							Remove one copy
						</button>
						{#each boardOptions as option}
							{#if option.value !== currentBoard}
								<button
									disabled={deckMutationBusy}
									onclick={() => mutateCard({ board: option.value })}
								>
									Move to {option.label}
								</button>
							{/if}
						{/each}
					{/if}
				</div>
			{/if}
		</div>
	</div>

	{#if expanded}
		<div class="mgr-card-details">
			{#each card.assignments as assignment, assignmentIdx}
				<ManagerRow {card} {assignment} {assignmentIdx} detail />
			{/each}
		</div>
	{/if}
</div>

<style>
	.mgr-card-block {
		border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
	}
	.mgr-card-block:last-child {
		border-bottom: 0;
	}
	.mgr-card-row {
		display: grid;
		grid-template-columns: 20px 28px minmax(0, 1fr) auto 50px;
		align-items: center;
		min-height: 32px;
		padding: 5px 6px 5px 4px;
		border-left: 3px solid transparent;
		transition: background 70ms;
	}
	.mgr-card-row:hover {
		background: color-mix(in srgb, var(--text) 3%, var(--surface));
	}
	.mgr-card-row--selected {
		background: color-mix(in srgb, var(--accent) 6%, var(--surface));
	}
	.mgr-card-row--pulled {
		border-left-color: var(--success);
	}
	.mgr-card-row--return {
		border-left-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 5%, var(--surface));
	}
	.mgr-card-row--missing {
		border-left-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 4%, var(--surface));
	}
	.mgr-card-row--needs-print,
	.mgr-card-row--needed {
		border-left-color: var(--warning);
	}
	.mgr-card-row--assigned {
		border-left-color: var(--assigned);
	}
	.mgr-card-row--proxied {
		border-left-color: var(--proxy);
	}
	.mgr-card-row--ordered {
		border-left-color: color-mix(in srgb, var(--warning) 55%, var(--text-muted));
	}
	.mgr-card-row--unassigned {
		border-left-color: color-mix(in srgb, var(--border) 70%, transparent);
	}
	.mgr-card-check-col {
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		cursor: pointer;
		transition: opacity 100ms;
	}
	.mgr-card-row:hover .mgr-card-check-col,
	.mgr-card-check-col--visible {
		opacity: 1;
	}
	.mgr-card-check {
		width: 13px;
		height: 13px;
		accent-color: var(--accent);
		cursor: pointer;
	}
	.mgr-card-qty {
		padding-right: 8px;
		color: var(--text-muted);
		font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
		font-size: 12px;
		font-weight: 600;
		text-align: right;
	}
	.mgr-card-name {
		display: flex;
		align-items: center;
		min-width: 0;
		overflow: hidden;
	}
	:global(.mgr-card-row .mgr-card-link) {
		overflow: hidden;
		color: var(--text);
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	:global(.mgr-card-row .mgr-card-link:hover) {
		color: var(--accent);
	}
	.mgr-sync-badge {
		flex-shrink: 0;
		margin-left: 6px;
		padding: 1px 4px;
		border: 1px solid currentColor;
		border-radius: 3px;
		font-size: 9px;
		font-weight: 800;
		line-height: 1.35;
		letter-spacing: 0;
		white-space: nowrap;
	}
	.mgr-sync-badge--added {
		color: var(--assigned);
		background: color-mix(in srgb, var(--assigned) 8%, var(--surface));
	}
	.mgr-sync-badge--return {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 8%, var(--surface));
	}
	.mgr-card-printing {
		flex-shrink: 0;
		padding: 0 0 0 6px;
		border: 0;
		background: none;
		color: var(--text-muted);
		font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
		font-size: 10px;
		line-height: 1;
		opacity: 0.65;
		cursor: pointer;
		white-space: nowrap;
	}
	.mgr-card-printing:hover {
		color: var(--accent);
		opacity: 1;
	}
	.mgr-card-note {
		flex-shrink: 0;
		margin-left: 5px;
		color: var(--accent);
		font-size: 9px;
		font-weight: 700;
	}
	.mgr-card-badges {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		min-width: 24px;
		padding: 0 2px;
		border: 0;
		background: none;
		cursor: pointer;
	}
	.mgr-card-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		margin-left: -5px;
		border: 2px solid var(--surface);
		border-radius: 50%;
		color: #fff;
		font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
		font-size: 9px;
		font-weight: 900;
		line-height: 1;
	}
	.mgr-card-badge:first-child {
		margin-left: 0;
	}
	.mgr-card-badge--in-deck {
		background: var(--assigned);
	}
	.mgr-card-badge--available {
		background: color-mix(in srgb, var(--text-muted) 58%, var(--surface));
	}
	.mgr-card-badge--print {
		background: var(--warning);
	}
	.mgr-card-badge--not-owned {
		border-color: color-mix(in srgb, var(--danger) 55%, var(--surface));
		background: var(--surface);
		color: var(--danger);
	}
	.mgr-card-badge--info {
		border-color: color-mix(in srgb, var(--text-muted) 38%, var(--surface));
		background: var(--surface);
		color: var(--text-muted);
		font-family: ui-serif, Georgia, serif;
		font-size: 11px;
		font-style: italic;
	}
	.mgr-card-badge--ordered,
	.mgr-card-badge--unassigned {
		border-color: color-mix(in srgb, var(--border) 70%, var(--surface));
		background: var(--surface);
		color: var(--text-muted);
		opacity: 0.55;
	}
	.mgr-card-actions {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: flex-end;
	}
	.mgr-card-expand,
	.mgr-card-menu-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 23px;
		height: 23px;
		padding: 0;
		border: 0;
		border-radius: 3px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}
	.mgr-card-expand {
		font-size: 16px;
	}
	.mgr-card-menu-btn {
		font-size: 14px;
		opacity: 0.25;
	}
	.mgr-card-row:hover .mgr-card-menu-btn {
		opacity: 0.65;
	}
	.mgr-card-expand:hover,
	.mgr-card-menu-btn:hover {
		background: var(--surface-2);
		color: var(--text);
		opacity: 1;
	}
	.mgr-card-menu-overlay {
		position: fixed;
		z-index: 79;
		inset: 0;
	}
	.mgr-card-menu {
		position: absolute;
		z-index: 80;
		top: calc(100% + 3px);
		right: 0;
		min-width: 170px;
		padding: 4px 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
		max-height: calc(100vh - 16px);
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.mgr-card-menu button {
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
	.mgr-card-menu button:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.mgr-card-menu .mgr-card-menu-note {
		color: var(--accent);
	}
	.mgr-card-menu hr {
		margin: 4px 0;
		border: 0;
		border-top: 1px solid var(--border);
	}
	.mgr-card-menu .mgr-card-menu-danger {
		color: color-mix(in srgb, var(--danger) 75%, var(--text-muted));
	}
	.mgr-card-details {
		background: color-mix(in srgb, var(--surface-2) 42%, var(--surface));
		border-top: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
	}
	:global(.mgr-card-details .mgr-row) {
		padding-left: 18px;
	}
	@media (max-width: 640px) {
		.mgr-card-row {
			grid-template-columns: 18px 24px minmax(0, 1fr) auto 46px;
			padding-right: 3px;
		}
		.mgr-card-printing {
			display: none;
		}
	}
</style>
