<script lang="ts">
	import { getContext } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { ManagerCard, ManagerAssignment, ManagerCtx, CopyOption } from './manager-types';
	import { isBasicLand } from '$lib/basics';

	let {
		card,
		assignment,
		assignmentIdx,
		detail = false
	}: {
		card: ManagerCard;
		assignment: ManagerAssignment;
		assignmentIdx: number;
		detail?: boolean;
	} = $props();

	const ctx = getContext<ManagerCtx>('manager');

	// ── Local UI state ────────────────────────────────────────────────────
	let menuOpen = $state(false);
	let copyDropdownUpward = $state(false);
	let copyDropdownMaxHeight = $state(320);
	let actionsElement: HTMLElement;
	let deckMutationBusy = $state(false);
	let reserveProxyBusy = $state(false);
	let reserveProxyError = $state('');
	let proxyPrintBusy = $state(false);
	let proxyPrintError = $state('');
	const boardOptions = [
		{ value: 'main', label: 'Main' },
		{ value: 'commander', label: 'Commander' },
		{ value: 'side', label: 'Sideboard' },
		{ value: 'maybe', label: 'Maybeboard' }
	] as const;
	const currentBoard = $derived((card.board ?? 'main') as (typeof boardOptions)[number]['value']);

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

	// ── Popover state ─────────────────────────────────────────────────────
	let popoverVisible = $state(false);
	let popoverUpward = $state(false);
	let popoverByClick = $state(false); // keeps open on mobile tap
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	function showPopover(e: MouseEvent | FocusEvent) {
		if (closeTimer) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
		const el = (e.currentTarget as HTMLElement).closest('.mgr-icon-wrap') as HTMLElement | null;
		if (el) {
			const rect = el.getBoundingClientRect();
			popoverUpward = window.innerHeight - rect.bottom < 180;
		}
		popoverVisible = true;
	}
	function scheduleHide() {
		closeTimer = setTimeout(() => {
			popoverVisible = false;
			popoverByClick = false;
		}, 120);
	}
	function togglePopoverClick(e: MouseEvent) {
		e.stopPropagation();
		if (popoverVisible && popoverByClick) {
			popoverVisible = false;
			popoverByClick = false;
		} else {
			popoverByClick = true;
			showPopover(e);
		}
	}

	// ── Fulfillment + pull derived ────────────────────────────────────────
	const isPulled = $derived(assignment.pulled === true);
	const isRealCard = $derived(assignment.status === 'assigned');
	const isProxy = $derived(assignment.status === 'proxied');
	const presentedAsReal = $derived(isRealCard);
	const isFulfilled = $derived(isRealCard || isProxy);
	const isUnfulfilled = $derived(!isFulfilled);
	const isNeeded = $derived(assignment.status === 'needed');
	const isSub = $derived(detail || assignmentIdx > 0);
	const isSyncReturn = $derived(card.syncReturnAssignmentIds?.includes(assignment.id) ?? false);

	// Not Owned: no collection copies, unfulfilled slot, non-basic (when ignoreBasics on)
	const isNotOwned = $derived(
		(isNeeded || assignment.status === 'unassigned') &&
			(card.collQty ?? 0) === 0 &&
			!(ctx.ignoreBasics && isBasicLand(card.cardName))
	);
	// All Copies Used: has collection copies but all committed to decks, unfulfilled slot
	const isAllCopiesUsed = $derived(
		(isNeeded || assignment.status === 'unassigned') &&
			(card.collQty ?? 0) > 0 &&
			(card.availableQty ?? -1) === 0
	);
	// Legacy isMissing alias (for rowClass border — Not Owned is the red state)
	const isMissing = $derived(isNotOwned);

	const needsPrint = $derived(
		isProxy && assignment.printStatus === 'need_print' && assignment.proxyInventoryId === null
	);
	const needsReprint = $derived(isProxy && assignment.printStatus === 'need_reprint');
	const hasLinkedRealCopy = $derived(isRealCard && assignment.collectionId !== null);
	const canPull = $derived(hasLinkedRealCopy || isProxy);
	const availableProxyCopies = $derived(card.availableProxyInventory ?? []);
	const reserveProxyCopy = $derived(availableProxyCopies[0] ?? null);
	const canReserveProxyCopy = $derived(
		isProxy && !isPulled && assignment.proxyInventoryId === null && reserveProxyCopy !== null
	);

	// ── Status icon ───────────────────────────────────────────────────────
	// Text glyph
	const iconText = $derived.by(() => {
		if (isNotOwned) return 'X';
		if (isAllCopiesUsed) return 'i';
		if (assignment.status === 'unassigned') return '·';
		if (assignment.status === 'ordered') return 'O';
		if (isNeeded) return 'i';
		if (presentedAsReal) return '✓';
		if (isProxy) return needsReprint ? 'RP' : 'P';
		return '·';
	});

	// CSS class for icon color
	const iconClass = $derived.by(() => {
		if (isPulled && (needsReprint || needsPrint)) return 'mgr-icon--proxy-print';
		if (isPulled) return 'mgr-icon--in-deck';
		if (needsReprint || needsPrint) return 'mgr-icon--proxy-print';
		if (hasLinkedRealCopy || isProxy) return 'mgr-icon--available';
		if (isNotOwned) return 'mgr-icon--not-owned';
		if (isAllCopiesUsed) return 'mgr-icon--info';
		if (isNeeded) return 'mgr-icon--info';
		if (assignment.status === 'ordered') return 'mgr-icon--ordered';
		if (assignment.status === 'unassigned') return 'mgr-icon--unassigned';
		return 'mgr-icon--unassigned';
	});

	// ── Row left-border class (unchanged from Phase 2) ────────────────────
	const rowClass = $derived.by(() => {
		if (isSyncReturn) return 'mgr-row--return';
		if (isPulled) return 'mgr-row--pulled';
		if (isMissing) return 'mgr-row--missing';
		if (isNeeded) return 'mgr-row--needed';
		if (assignment.status === 'ordered') return 'mgr-row--ordered';
		if (presentedAsReal) return 'mgr-row--assigned';
		if (needsPrint || needsReprint) return 'mgr-row--needs-print';
		if (isProxy) return 'mgr-row--proxied';
		return 'mgr-row--unassigned';
	});

	// ── Popover content ───────────────────────────────────────────────────
	const LOC_LABEL: Record<string, string> = {
		binder: 'Binder',
		box_w: 'Box W',
		box_u: 'Box U',
		box_b: 'Box B',
		box_r: 'Box R',
		box_g: 'Box G',
		box_multi: 'Multi',
		box_colorless: 'Clrls',
		box_land: 'Lands',
		unknown: '?'
	};

	const popoverStatusLine = $derived.by(() => {
		if (isPulled && presentedAsReal) return 'In deck — real card';
		if (isPulled && isProxy) return 'In deck — proxy';
		if (presentedAsReal) return 'Assigned, not in deck';
		if (needsReprint) return 'Proxy — needs reprint';
		if (needsPrint) return 'Proxy — needs print';
		if (isProxy) return 'Proxy — not in deck';
		if (isNotOwned) return 'Not owned';
		if (isAllCopiesUsed) return 'All copies in use';
		if (isNeeded) return 'Needed';
		if (assignment.status === 'ordered') return 'Ordered';
		if (assignment.status === 'unassigned') return 'Unassigned';
		return assignment.status;
	});

	const popoverLocationLine = $derived.by(() => {
		if (isPulled) return 'Location: Deck';
		if (isRealCard) {
			const loc = assignment.location;
			if (loc && loc !== 'proxy_box' && loc !== 'ordered') {
				return `Location: ${LOC_LABEL[loc] ?? loc}`;
			}
		}
		if (isProxy && !isPulled) return 'Location: Proxy Box';
		return null;
	});

	const popoverPrintingLine = $derived.by(() => {
		if (assignment.collSetCode) {
			const foil = assignment.collFoil ? ' · Foil' : '';
			const cond =
				assignment.collCondition && assignment.collCondition !== 'NM'
					? ` · ${assignment.collCondition}`
					: '';
			return `Printing: ${assignment.collSetCode.toUpperCase()} #${assignment.collCollectorNumber}${foil}${cond}`;
		}
		if (assignment.proxySetCode) {
			return `Printing: ${assignment.proxySetCode.toUpperCase()} #${assignment.proxyCollectorNumber}`;
		}
		return null;
	});

	const popoverNoteLine = $derived.by(() => (assignment.note ? `Note: ${assignment.note}` : null));

	function formatLocation(location: string | null) {
		if (!location) return 'auto';
		return LOC_LABEL[location] ?? location.replaceAll('_', ' ');
	}

	function formatAssignedDecks(decks: string[]) {
		if (decks.length === 0) return null;
		if (decks.length <= 2) return decks.join(', ');
		return `${decks.slice(0, 2).join(', ')} +${decks.length - 2}`;
	}

	function formatOwnedPrinting(printing: ManagerCard['collectionPrintings'][number]) {
		const foil = printing.foil ? ' F' : '';
		const cond = printing.condition && printing.condition !== 'NM' ? ` ${printing.condition}` : '';
		const decks = formatAssignedDecks(printing.assignedDecks);
		const usage = `${printing.available}/${printing.quantity} free`;
		const location = formatLocation(printing.locationOverride);
		return {
			label: `${printing.setCode.toUpperCase()} #${printing.collectorNumber}${foil}${cond}`,
			detail: decks ? `${usage} · ${location} · ${decks}` : `${usage} · ${location}`
		};
	}

	const popoverOwnershipLine = $derived.by(() => {
		if (card.collQty <= 0) return 'Owned: none';
		return `Owned: ${card.collQty} · Free: ${card.availableQty}`;
	});

	const popoverOwnedPrintings = $derived.by(() =>
		(card.collectionPrintings ?? []).slice(0, 4).map(formatOwnedPrinting)
	);

	const popoverHiddenPrintingCount = $derived(
		Math.max(0, (card.collectionPrintings?.length ?? 0) - popoverOwnedPrintings.length)
	);

	const popoverProxyInventoryLines = $derived.by(() =>
		availableProxyCopies.slice(0, 3).map((copy) => {
			const printing =
				copy.setCode && copy.collectorNumber
					? `${copy.setCode.toUpperCase()} #${copy.collectorNumber}`
					: 'unlisted printing';
			const state = copy.printState === 'needs_reprint' ? 'needs reprint' : 'ready';
			return `${printing} · ${state} · ${formatLocation(copy.location)}`;
		})
	);

	const popoverHiddenProxyCount = $derived(
		Math.max(0, availableProxyCopies.length - popoverProxyInventoryLines.length)
	);

	// ── Copy dropdown ─────────────────────────────────────────────────────
	const showDropdown = $derived(ctx.copyDropdownId === assignment.id);
	const cachedCopies = $derived(ctx.copyDropdownCache.get(assignment.id) ?? []);

	const copyLabel = $derived.by(() => {
		if (assignment.collSetCode) {
			return `${assignment.collSetCode.toUpperCase()} #${assignment.collCollectorNumber}${assignment.collFoil ? ' F' : ''}`;
		}
		if (assignment.proxySetCode) {
			return `${assignment.proxySetCode.toUpperCase()} #${assignment.proxyCollectorNumber}`;
		}
		return null;
	});

	function getCopyClickStatus(_copy: CopyOption): string {
		return 'assigned';
	}

	function openMenu(e: MouseEvent) {
		e.stopPropagation();
		menuOpen = !menuOpen;
	}

	function openCopyDropdown() {
		const rect = actionsElement.getBoundingClientRect();
		const spaceAbove = Math.max(48, rect.top - 8);
		const spaceBelow = Math.max(48, window.innerHeight - rect.bottom - 8);
		copyDropdownUpward = spaceBelow < 280 && spaceAbove > spaceBelow;
		copyDropdownMaxHeight = Math.floor(copyDropdownUpward ? spaceAbove : spaceBelow);
		return ctx.openCopyDropdown(assignment.id);
	}

	function formatProxyCopy(copy: NonNullable<typeof reserveProxyCopy>) {
		const printing =
			copy.setCode && copy.collectorNumber
				? `${copy.setCode.toUpperCase()} #${copy.collectorNumber}`
				: 'unlisted printing';
		return copy.printState === 'needs_reprint' ? `${printing} · needs reprint` : printing;
	}

	async function reserveAvailableProxy() {
		if (!reserveProxyCopy || reserveProxyBusy) return;
		reserveProxyBusy = true;
		reserveProxyError = '';
		menuOpen = false;
		try {
			const response = await fetch(`/api/proxy-inventory/${reserveProxyCopy.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ assignmentId: assignment.id })
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => null);
				throw new Error(payload?.message ?? 'Could not reserve printed proxy');
			}
			await invalidateAll();
		} catch (error) {
			reserveProxyError =
				error instanceof Error ? error.message : 'Could not reserve printed proxy';
		} finally {
			reserveProxyBusy = false;
		}
	}

	async function markProxyPrinted(pull = false) {
		if (proxyPrintBusy) return;
		proxyPrintBusy = true;
		proxyPrintError = '';
		menuOpen = false;
		const previous = {
			printStatus: assignment.printStatus,
			pulled: assignment.pulled,
			proxyInventoryId: assignment.proxyInventoryId
		};
		ctx.applyLocalPatch(assignment.id, {
			printStatus: null,
			proxyInventoryId: -1,
			...(pull ? { pulled: true } : {})
		});
		try {
			const printed = await fetch('/api/proxy-inventory', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ assignmentId: assignment.id })
			});
			if (!printed.ok) {
				const payload = await printed.json().catch(() => null);
				throw new Error(payload?.message ?? 'Could not mark proxy printed');
			}
			const created = await printed.json().catch(() => null);
			if (typeof created?.id === 'number') {
				ctx.applyLocalPatch(assignment.id, {
					printStatus: null,
					proxyInventoryId: created.id
				});
			}
			if (pull) {
				const pulled = await fetch(`/api/assignments/${assignment.id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ pulled: true })
				});
				if (!pulled.ok) {
					const payload = await pulled.json().catch(() => null);
					throw new Error(payload?.message ?? 'Printed, but could not pull');
				}
			}
			await invalidateAll();
		} catch (error) {
			ctx.applyLocalPatch(assignment.id, previous);
			proxyPrintError = error instanceof Error ? error.message : 'Could not mark proxy printed';
		} finally {
			proxyPrintBusy = false;
		}
	}

	const copyActionLabel = $derived.by(() => {
		if (!isFulfilled && isUnfulfilled) return 'Assign copy…';
		if (copyLabel) return 'Change printing…';
		if (isRealCard && !assignment.collectionId) return 'Link copy…';
		if (isProxy) return 'Link printing…';
		return 'Assign copy…';
	});

	const previewPrinting = $derived.by(() => copyLabel);
	function updatePreview() {
		ctx.setPreviewCard({
			name: card.cardName,
			imageUri: assignment.imageUri ?? card.fallbackImageUri ?? null,
			printing: previewPrinting
		});
	}

	const isSelected = $derived(ctx.selectedIds.has(assignment.id));
	const anySelected = $derived(ctx.selectedIds.size > 0);
</script>

<!-- Row: Checkbox | Qty | Name + printing | Status Icon | ⋯ menu -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="mgr-row {rowClass}"
	class:mgr-row--sub={isSub}
	class:mgr-row--selected={isSelected}
	onmouseenter={updatePreview}
	onfocusin={updatePreview}
>
	<!-- 0. Checkbox -->
	<label class="mgr-check-col" class:mgr-check-col--visible={anySelected || isSelected}>
		<input
			type="checkbox"
			class="mgr-check"
			checked={isSelected}
			onchange={() => ctx.toggleSelect(assignment.id)}
			aria-label="Select {card.cardName}"
		/>
	</label>

	<!-- 1. Qty -->
	<span class="mgr-qty-col">
		{#if !isSub}{card.quantity}{/if}
	</span>

	<!-- 2. Card name + compact printing info -->
	<div class="mgr-name">
		{#if !isSub}
			<a
				href="/cards/{encodeURIComponent(card.cardName)}"
				class="card-link mgr-card-link"
				data-sveltekit-preload-data="off">{card.cardName}</a
			>
			{#if card.syncAddedQuantity > 0}
				<span
					class="mgr-sync-badge mgr-sync-badge--added"
					title="{card.syncAddedQuantity} added by Moxfield sync"
					>NEW{card.syncAddedQuantity > 1 ? ` ×${card.syncAddedQuantity}` : ''}</span
				>
			{/if}
			{#if isSyncReturn}
				<span
					class="mgr-sync-badge mgr-sync-badge--return"
					title="This packed copy must be removed from the deck">TAKE OUT</span
				>
			{/if}
			{#if copyLabel}
				<button class="mgr-printing" onclick={openCopyDropdown} title="Change printing">
					{copyLabel}
				</button>
			{/if}
			{#if card.notes}
				<span class="mgr-has-note" title={card.notes}>✎</span>
			{/if}
		{:else}
			<span class="mgr-sub-label">Copy {assignmentIdx + 1}</span>
			{#if isSyncReturn}
				<span class="mgr-sync-badge mgr-sync-badge--return">TAKE OUT</span>
			{/if}
			{#if copyLabel}
				<button class="mgr-printing" onclick={openCopyDropdown} title="Change printing">
					{copyLabel}
				</button>
			{/if}
		{/if}
	</div>

	<!-- 3. Status icon + info popover -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="mgr-icon-wrap" onmouseenter={showPopover} onmouseleave={scheduleHide}>
		<button
			class="mgr-icon {iconClass}"
			onclick={togglePopoverClick}
			onfocus={showPopover}
			onblur={scheduleHide}
			aria-label={popoverStatusLine}
			title={popoverStatusLine}>{iconText}</button
		>

		{#if popoverVisible}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="mgr-popover"
				class:mgr-popover--up={popoverUpward}
				onmouseenter={showPopover}
				onmouseleave={scheduleHide}
			>
				<div class="mgr-popover-status">{popoverStatusLine}</div>
				{#if !isSub}
					<div class="mgr-popover-card">
						{card.cardName}{card.quantity > 1 ? ` ×${card.quantity}` : ''}
					</div>
				{/if}
				{#if popoverPrintingLine}
					<div class="mgr-popover-detail">{popoverPrintingLine}</div>
				{/if}
				{#if popoverLocationLine}
					<div class="mgr-popover-detail">{popoverLocationLine}</div>
				{/if}
				<div class="mgr-popover-section">
					<div class="mgr-popover-section-title">Collection</div>
					<div class="mgr-popover-detail">{popoverOwnershipLine}</div>
					{#if popoverOwnedPrintings.length > 0}
						{#each popoverOwnedPrintings as owned}
							<div class="mgr-popover-printing">
								<span>{owned.label}</span>
								<small>{owned.detail}</small>
							</div>
						{/each}
						{#if popoverHiddenPrintingCount > 0}
							<div class="mgr-popover-detail">
								+{popoverHiddenPrintingCount} more owned printing{popoverHiddenPrintingCount === 1
									? ''
									: 's'}
							</div>
						{/if}
					{/if}
					{#if card.conflictDecks.length > 0}
						<div class="mgr-popover-detail mgr-popover-conflict">
							Assigned in: {card.conflictDecks.join(', ')}
						</div>
					{/if}
				</div>
				{#if popoverProxyInventoryLines.length > 0}
					<div class="mgr-popover-section">
						<div class="mgr-popover-section-title">Printed proxies</div>
						{#each popoverProxyInventoryLines as line}
							<div class="mgr-popover-detail">{line}</div>
						{/each}
						{#if popoverHiddenProxyCount > 0}
							<div class="mgr-popover-detail">
								+{popoverHiddenProxyCount} more printed prox{popoverHiddenProxyCount === 1
									? 'y'
									: 'ies'}
							</div>
						{/if}
					</div>
				{/if}
				{#if needsPrint || needsReprint}
					<div class="mgr-popover-detail" style="color:var(--warning)">
						{needsReprint ? 'Needs reprint' : 'Needs print'}
					</div>
				{/if}
				{#if popoverNoteLine}
					<div class="mgr-popover-detail mgr-popover-note">{popoverNoteLine}</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- 4. ⋯ menu — all actions + copy dropdown anchor -->
	{#if menuOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			style="position:fixed;inset:0;z-index:59"
			onclick={() => (menuOpen = false)}
			onkeydown={(e) => e.key === 'Escape' && (menuOpen = false)}
			aria-hidden="true"
		></div>
	{/if}
	<div class="mgr-actions" style="position:relative" bind:this={actionsElement}>
		<!-- Copy dropdown -->
		{#if showDropdown}
			<div
				class="mgr-dropdown mgr-copy-dropdown"
				class:mgr-dropdown--up={copyDropdownUpward}
				style:--mgr-dropdown-max-height="{copyDropdownMaxHeight}px"
			>
				{#if ctx.copyDropdownLoading && cachedCopies.length === 0}
					<div class="mgr-dropdown-msg">Loading…</div>
				{:else if cachedCopies.length === 0}
					<div class="mgr-dropdown-msg">Not in collection</div>
				{:else}
					{#each cachedCopies as copy}
						{@const isCurrent = copy.id === assignment.collectionId}
						{@const hasConflict = copy.available <= 0 && !isCurrent && copy.conflicts.length > 0}
						{#if hasConflict}
							<div class="mgr-conflict-card">
								<div class="mgr-conflict-header">
									<span class="mono" style="font-size:11px"
										>{copy.setCode.toUpperCase()} #{copy.collectorNumber}{#if copy.foil}
											F{/if}</span
									>
									<span class="mgr-conflict-used"
										>used by {copy.conflicts.map((c) => c.deckName).join(', ')}</span
									>
								</div>
								<div class="mgr-conflict-actions">
									<button
										class="mgr-conflict-btn mgr-conflict-btn--take"
										onclick={async () => {
											ctx.closeCopyDropdown();
											await ctx.patchAssignment(assignment.id, {
												status: getCopyClickStatus(copy),
												collectionId: copy.id,
												override: true,
												proxifyConflicts: true
											});
										}}>Take it — they'll proxy</button
									>
									<button
										class="mgr-conflict-btn mgr-conflict-btn--proxy"
										onclick={async () => {
											ctx.closeCopyDropdown();
											await ctx.patchAssignment(assignment.id, {
												status: 'proxied',
												collectionId: null
											});
										}}>Proxy this slot</button
									>
								</div>
							</div>
						{:else}
							<button
								class="mgr-dropdown-option"
								disabled={!isCurrent && copy.available <= 0}
								style="opacity:{isCurrent || copy.available > 0 ? 1 : 0.35}"
								onclick={async () => {
									ctx.closeCopyDropdown();
									await ctx.patchAssignment(assignment.id, {
										status: getCopyClickStatus(copy),
										collectionId: copy.id
									});
								}}
							>
								<span class="mono" style="font-size:12px">
									{copy.setCode.toUpperCase()} #{copy.collectorNumber}{#if copy.foil}<span
											class="mgr-foil"
										>
											F</span
										>{/if}{#if isCurrent}<span class="mgr-current"> ✓</span>{/if}
								</span>
								<span
									style="font-size:11px;color:{copy.available > 0
										? 'var(--text-muted)'
										: 'var(--error)'}"
								>
									{copy.available}/{copy.quantity}
								</span>
							</button>
						{/if}
					{/each}
				{/if}
				<hr class="mgr-divider" />
				{#if assignment.status !== 'proxied'}
					<button
						class="mgr-dropdown-action"
						onclick={() => {
							ctx.closeCopyDropdown();
							ctx.patchAssignment(assignment.id, {
								status: 'proxied',
								collectionId: null,
								pulled: false
							});
						}}>Mark as Proxy</button
					>
				{/if}
				{#if assignment.status !== 'needed'}
					<button
						class="mgr-dropdown-action"
						onclick={() => {
							ctx.closeCopyDropdown();
							ctx.patchAssignment(assignment.id, { status: 'needed', collectionId: null });
						}}>Mark as Needed</button
					>
				{/if}
				{#if assignment.status !== 'unassigned'}
					<button
						class="mgr-dropdown-action mgr-action-reset"
						onclick={() => {
							ctx.closeCopyDropdown();
							ctx.patchAssignment(assignment.id, { status: 'unassigned', collectionId: null });
						}}>✕ Unassign</button
					>
				{/if}
			</div>
		{/if}

		<!-- ⋯ trigger -->
		<button class="mgr-menu-btn" title="Actions" onclick={openMenu}>⋯</button>

		<!-- ⋯ menu dropdown -->
		{#if menuOpen}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="mgr-dropdown mgr-menu-dropdown"
				onkeydown={(e) => e.key === 'Escape' && (menuOpen = false)}
			>
				{#if canPull && !isPulled}
					{#if isProxy && (needsPrint || needsReprint)}
						<button
							class="mgr-dropdown-action mgr-action-pull"
							disabled={proxyPrintBusy}
							onclick={() => markProxyPrinted(true)}
						>
							{proxyPrintBusy ? 'Marking...' : 'Mark printed + pull'}
						</button>
					{:else}
						<button
							class="mgr-dropdown-action mgr-action-pull"
							onclick={() => {
								menuOpen = false;
								ctx.patchAssignment(assignment.id, { pulled: true });
							}}>Pull</button
						>
					{/if}
				{/if}
				{#if isPulled}
					<button
						class="mgr-dropdown-action"
						onclick={() => {
							menuOpen = false;
							ctx.patchAssignment(assignment.id, { pulled: false });
						}}>Unpull</button
					>
				{/if}
				<button
					class="mgr-dropdown-action"
					onclick={() => {
						menuOpen = false;
						openCopyDropdown();
					}}>{copyActionLabel}</button
				>
				{#if isProxy}
					<hr class="mgr-divider" />
					{#if canReserveProxyCopy}
						<button
							class="mgr-dropdown-action mgr-action-reserve"
							disabled={reserveProxyBusy}
							title="Reserve {formatProxyCopy(reserveProxyCopy)} from Proxy Inventory"
							onclick={reserveAvailableProxy}
						>
							{reserveProxyBusy
								? 'Reserving...'
								: `Reserve printed proxy${availableProxyCopies.length > 1 ? ` (${availableProxyCopies.length})` : ''}`}
						</button>
					{/if}
					{#if needsReprint}
						<div class="mgr-print-label" style="color:var(--error)">Reprint needed</div>
						<button
							class="mgr-dropdown-action"
							disabled={proxyPrintBusy}
							onclick={() => markProxyPrinted(false)}
						>
							{proxyPrintBusy ? 'Marking...' : 'Mark as printed'}
						</button>
						{#if !isPulled}
							<button
								class="mgr-dropdown-action mgr-action-pull"
								disabled={proxyPrintBusy}
								onclick={() => markProxyPrinted(true)}>Mark printed + pull</button
							>
						{/if}
					{:else if needsPrint}
						<div class="mgr-print-label" style="color:var(--warning)">Print needed</div>
						<button
							class="mgr-dropdown-action"
							disabled={proxyPrintBusy}
							onclick={() => markProxyPrinted(false)}
						>
							{proxyPrintBusy ? 'Marking...' : 'Mark as printed'}
						</button>
						{#if !isPulled}
							<button
								class="mgr-dropdown-action mgr-action-pull"
								disabled={proxyPrintBusy}
								onclick={() => markProxyPrinted(true)}>Mark printed + pull</button
							>
						{/if}
					{:else}
						<button
							class="mgr-dropdown-action"
							onclick={() => {
								menuOpen = false;
								ctx.patchPrintStatus(assignment.id, 'need_print');
							}}>Needs print</button
						>
						<button
							class="mgr-dropdown-action"
							onclick={() => {
								menuOpen = false;
								ctx.patchPrintStatus(assignment.id, 'need_reprint');
							}}>Needs reprint</button
						>
					{/if}
					{#if proxyPrintError}
						<div class="mgr-action-error">{proxyPrintError}</div>
					{/if}
					{#if reserveProxyError}
						<div class="mgr-action-error">{reserveProxyError}</div>
					{/if}
				{/if}
				<hr class="mgr-divider" />
				{#if isFulfilled}
					{#if !isProxy}
						<button
							class="mgr-dropdown-action"
							onclick={() => {
								menuOpen = false;
								ctx.patchAssignment(assignment.id, { status: 'proxied', pulled: false });
							}}>Mark as Proxy</button
						>
					{/if}
					<button
						class="mgr-dropdown-action mgr-action-reset"
						onclick={() => {
							menuOpen = false;
							ctx.patchAssignment(assignment.id, { status: 'unassigned', collectionId: null });
						}}>✕ Unassign</button
					>
				{:else if isNeeded}
					<button
						class="mgr-dropdown-action"
						onclick={() => {
							menuOpen = false;
							ctx.patchAssignment(assignment.id, { status: 'ordered' });
						}}>Mark Ordered</button
					>
					<button
						class="mgr-dropdown-action"
						onclick={() => {
							menuOpen = false;
							ctx.patchAssignment(assignment.id, { status: 'proxied', pulled: false });
						}}>Mark as Proxy</button
					>
					<button
						class="mgr-dropdown-action mgr-action-reset"
						onclick={() => {
							menuOpen = false;
							ctx.patchAssignment(assignment.id, { status: 'unassigned' });
						}}>Reset to Unassigned</button
					>
				{:else if assignment.status === 'ordered'}
					<button
						class="mgr-dropdown-action"
						onclick={() => {
							menuOpen = false;
							ctx.patchAssignment(assignment.id, { status: 'proxied', pulled: false });
						}}>Mark as Proxy</button
					>
					<button
						class="mgr-dropdown-action mgr-action-reset"
						onclick={() => {
							menuOpen = false;
							ctx.patchAssignment(assignment.id, { status: 'unassigned' });
						}}>Reset to Unassigned</button
					>
				{:else}
					<button
						class="mgr-dropdown-action"
						onclick={() => {
							menuOpen = false;
							ctx.patchAssignment(assignment.id, { status: 'needed' });
						}}>Mark as Needed</button
					>
					<button
						class="mgr-dropdown-action"
						onclick={() => {
							menuOpen = false;
							ctx.patchAssignment(assignment.id, { status: 'proxied', pulled: false });
						}}>Mark as Proxy</button
					>
				{/if}
				{#if !isSub}
					<hr class="mgr-divider" />
					<button
						class="mgr-dropdown-action"
						class:mgr-has-note={!!card.notes}
						onclick={() => {
							menuOpen = false;
							ctx.openNoteModal(card.dcId, card.cardName, card.notes ?? '');
						}}
					>
						{card.notes ? 'Edit note ✎' : 'Add note'}
					</button>
				{/if}
				{#if ctx.canEditDeck && !isSub}
					<hr class="mgr-divider" />
					<button
						class="mgr-dropdown-action"
						disabled={deckMutationBusy}
						onclick={() => mutateCard({ quantity: card.quantity + 1 })}
					>
						Add copy
					</button>
					<button
						class="mgr-dropdown-action mgr-action-reset"
						disabled={deckMutationBusy}
						onclick={() => mutateCard({ quantity: card.quantity - 1 })}
					>
						{card.quantity === 1 ? 'Remove from deck' : 'Remove one copy'}
					</button>
					{#each boardOptions as option}
						{#if option.value !== currentBoard}
							<button
								class="mgr-dropdown-action"
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

<style>
	/* ── Row grid: Check | Qty | Name+printing | Icon | Menu ──────────────── */
	.mgr-row {
		display: grid;
		grid-template-columns: 20px 28px 1fr 28px 28px;
		column-gap: 0;
		align-items: center;
		padding: 5px 8px 5px 4px;
		min-height: 30px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
		border-left: 3px solid transparent;
		transition: background 0.07s;
	}
	.mgr-row:last-child {
		border-bottom: none;
	}

	/* Left-border status colors */
	.mgr-row--pulled {
		border-left-color: var(--success);
	}
	.mgr-row--assigned {
		border-left-color: var(--assigned);
	}
	.mgr-row--needed {
		border-left-color: var(--warning);
	}
	.mgr-row--ordered {
		border-left-color: color-mix(in srgb, var(--warning) 55%, var(--text-muted));
	}
	.mgr-row--return {
		border-left-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 5%, var(--surface));
	}
	.mgr-row--proxied {
		border-left-color: var(--proxy);
	}
	.mgr-row--needs-print {
		border-left-color: var(--warning);
	}
	.mgr-row--unassigned {
		border-left-color: color-mix(in srgb, var(--border) 70%, transparent);
	}
	.mgr-row--missing {
		border-left-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 4%, var(--surface));
	}
	.mgr-row:hover {
		background: color-mix(in srgb, var(--text) 3%, var(--surface));
	}
	.mgr-row--missing:hover {
		background: color-mix(in srgb, var(--danger) 7%, var(--surface));
	}
	.mgr-row--selected {
		background: color-mix(in srgb, var(--accent) 6%, var(--surface)) !important;
	}
	.mgr-row--sub {
		padding-left: 20px;
		opacity: 0.75;
	}

	/* ── Col 0: Checkbox ─────────────────────────────────────────────────── */
	.mgr-check-col {
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		transition: opacity 0.1s;
		cursor: pointer;
	}
	.mgr-check-col--visible,
	.mgr-row:hover .mgr-check-col {
		opacity: 1;
	}
	.mgr-check {
		width: 13px;
		height: 13px;
		accent-color: var(--accent);
		cursor: pointer;
		flex-shrink: 0;
	}
	.mgr-row--sub:hover {
		opacity: 1;
	}

	/* ── Col 1: Qty ──────────────────────────────────────────────────────── */
	.mgr-qty-col {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
		text-align: right;
		padding-right: 8px;
		font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
		user-select: none;
	}

	/* ── Col 2: Card name + printing ─────────────────────────────────────── */
	.mgr-name {
		display: flex;
		align-items: center;
		gap: 0;
		min-width: 0;
		overflow: hidden;
	}
	:global(.mgr-card-link) {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-decoration: none;
	}
	:global(.mgr-card-link:hover) {
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
	.mgr-printing {
		font-size: 10px;
		font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
		color: var(--text-muted);
		background: none;
		border: none;
		padding: 0 0 0 6px;
		cursor: pointer;
		flex-shrink: 0;
		white-space: nowrap;
		opacity: 0.65;
		line-height: 1;
	}
	.mgr-printing:hover {
		opacity: 1;
		color: var(--accent);
	}
	.mgr-has-note {
		font-size: 10px;
		color: var(--text-muted);
		opacity: 0.6;
		flex-shrink: 0;
		padding-left: 4px;
	}
	.mgr-sub-label {
		font-size: 11px;
		color: var(--text-muted);
		opacity: 0.6;
		padding-left: 2px;
	}

	/* ── Col 3: Status icon + popover wrapper ────────────────────────────── */
	.mgr-icon-wrap {
		position: relative;
		display: flex;
		justify-content: center;
		align-items: center;
	}

	/* Moxfield-style status badge: fast-read circle with text/icon contrast */
	.mgr-icon {
		display: inline-flex;
		justify-content: center;
		align-items: center;
		width: 20px;
		height: 20px;
		font-size: 10px;
		font-weight: 900;
		font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
		letter-spacing: 0;
		line-height: 1;
		border-radius: 50%;
		border: 2px solid transparent;
		padding: 0;
		cursor: pointer;
		user-select: none;
		transition: filter 0.1s;
		flex-shrink: 0;
	}
	.mgr-icon:hover {
		filter: brightness(1.15);
	}

	.mgr-icon--in-deck {
		background: var(--assigned);
		border-color: var(--assigned);
		color: #fff;
	}

	.mgr-icon--available {
		background: color-mix(in srgb, var(--text-muted) 58%, var(--surface));
		border-color: color-mix(in srgb, var(--text-muted) 58%, var(--surface));
		color: #fff;
	}

	.mgr-icon--proxy-print {
		background: var(--warning);
		border-color: var(--warning);
		color: #fff;
	}

	.mgr-icon--proxy-print:not(.mgr-icon--in-deck) {
		box-shadow: inset 0 0 0 1px color-mix(in srgb, #fff 38%, transparent);
	}

	.mgr-icon--info {
		background: var(--surface);
		border-color: color-mix(in srgb, var(--text-muted) 38%, transparent);
		color: var(--text-muted);
		font-family: ui-serif, Georgia, serif;
		font-weight: 700;
		font-style: italic;
		font-size: 12px;
	}

	.mgr-icon--not-owned {
		background: var(--surface);
		border-color: color-mix(in srgb, var(--danger) 55%, transparent);
		color: var(--danger);
		font-size: 8px;
	}

	.mgr-icon--ordered {
		background: var(--surface);
		border-color: color-mix(in srgb, var(--text-muted) 32%, transparent);
		color: var(--text-muted);
		opacity: 0.65;
	}

	.mgr-icon--unassigned {
		background: var(--surface);
		border-color: color-mix(in srgb, var(--border) 70%, transparent);
		color: var(--text-muted);
		opacity: 0.35;
	}

	/* ── Popover ─────────────────────────────────────────────────────────── */
	.mgr-popover {
		position: absolute;
		left: 50%;
		top: calc(100% + 6px);
		transform: translateX(-50%);
		z-index: 70;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		min-width: 240px;
		max-width: 340px;
		padding: 8px 10px;
		box-shadow: 0 4px 16px color-mix(in srgb, var(--text) 18%, transparent);
		pointer-events: auto;
	}
	.mgr-popover--up {
		top: auto;
		bottom: calc(100% + 6px);
	}
	/* Keep popover on-screen: don't clip left/right on narrow rows */
	.mgr-icon-wrap:first-child .mgr-popover {
		left: 0;
		transform: none;
	}

	.mgr-popover-status {
		font-size: 11px;
		font-weight: 700;
		color: var(--text);
		margin-bottom: 4px;
	}
	.mgr-popover-card {
		font-size: 11px;
		color: var(--text-muted);
		margin-bottom: 4px;
	}
	.mgr-popover-detail {
		font-size: 10px;
		color: var(--text-muted);
		line-height: 1.5;
		font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
	}
	.mgr-popover-section {
		margin-top: 7px;
		padding-top: 6px;
		border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
	}
	.mgr-popover-section-title {
		margin-bottom: 3px;
		color: var(--text-muted);
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.mgr-popover-printing {
		display: grid;
		grid-template-columns: minmax(0, 72px) 1fr;
		gap: 7px;
		align-items: baseline;
		font-size: 10px;
		line-height: 1.35;
	}
	.mgr-popover-printing span {
		overflow: hidden;
		color: var(--text);
		font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mgr-popover-printing small {
		min-width: 0;
		color: var(--text-muted);
		font-size: 10px;
	}
	.mgr-popover-note {
		font-family: inherit;
		font-style: italic;
	}
	.mgr-popover-conflict {
		font-family: inherit;
		color: var(--text-muted);
		white-space: normal;
	}

	/* ── Col 4: Actions (⋯ + dropdowns anchor) ──────────────────────────── */
	.mgr-actions {
		display: flex;
		justify-content: center;
		align-items: center;
	}
	.mgr-menu-btn {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-muted);
		font-size: 14px;
		padding: 2px 4px;
		border-radius: 3px;
		line-height: 1;
		opacity: 0.15;
		transition: opacity 0.1s;
	}
	.mgr-row:hover .mgr-menu-btn {
		opacity: 0.5;
	}
	.mgr-menu-btn:hover {
		opacity: 1 !important;
		background: var(--surface-2);
	}

	/* ── Dropdowns ───────────────────────────────────────────────────────── */
	.mgr-dropdown {
		position: absolute;
		z-index: 60;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		min-width: 190px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
		padding: 4px 0;
		max-height: var(--mgr-dropdown-max-height, calc(100vh - 16px));
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.mgr-menu-dropdown {
		right: 0;
		top: calc(100% + 3px);
	}
	.mgr-copy-dropdown {
		right: 0;
		top: calc(100% + 3px);
		min-width: 220px;
	}
	.mgr-dropdown--up.mgr-copy-dropdown {
		top: auto;
		bottom: calc(100% + 3px);
	}

	.mgr-dropdown-msg {
		padding: 8px 12px;
		font-size: 12px;
		color: var(--text-muted);
	}
	.mgr-dropdown-option {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		padding: 5px 12px;
		background: none;
		border: none;
		text-align: left;
		color: var(--text);
		cursor: pointer;
		font-size: 12px;
	}
	.mgr-dropdown-option:not(:disabled):hover {
		background: var(--surface-2);
	}
	.mgr-dropdown-option:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.mgr-dropdown-action {
		display: block;
		width: 100%;
		padding: 6px 12px;
		background: none;
		border: none;
		cursor: pointer;
		font-size: 12px;
		color: var(--text-muted);
		text-align: left;
	}
	.mgr-dropdown-action:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.mgr-action-pull {
		color: var(--success);
		font-weight: 600;
	}
	.mgr-action-pull:hover {
		color: var(--success);
	}
	.mgr-action-reserve {
		color: var(--proxy);
		font-weight: 700;
	}
	.mgr-action-reserve:hover {
		color: var(--proxy);
	}
	.mgr-action-reset {
		color: color-mix(in srgb, var(--error) 70%, var(--text-muted));
	}
	.mgr-action-reset:hover {
		color: var(--error);
	}
	.mgr-has-note {
		color: var(--accent);
	}
	.mgr-divider {
		margin: 4px 0;
		border: none;
		border-top: 1px solid var(--border);
	}
	.mgr-print-label {
		padding: 5px 12px 2px;
		font-size: 11px;
		font-weight: 600;
	}
	.mgr-action-error {
		padding: 5px 12px;
		color: var(--error);
		font-size: 10px;
		line-height: 1.3;
	}

	/* Conflict cards */
	.mgr-conflict-card {
		margin: 2px 6px 4px;
		padding: 7px 9px;
		border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border));
		border-radius: 5px;
		background: color-mix(in srgb, var(--warning) 5%, var(--surface));
	}
	.mgr-conflict-header {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 7px;
	}
	.mgr-conflict-used {
		font-size: 11px;
		color: var(--text-muted);
		font-style: italic;
	}
	.mgr-conflict-actions {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.mgr-conflict-btn {
		width: 100%;
		padding: 4px 8px;
		font-size: 11px;
		font-weight: 600;
		border-radius: 4px;
		cursor: pointer;
		text-align: left;
		border: 1px solid transparent;
	}
	.mgr-conflict-btn--take {
		background: color-mix(in srgb, var(--accent) 12%, var(--surface));
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
		color: var(--accent);
	}
	.mgr-conflict-btn--take:hover {
		background: color-mix(in srgb, var(--accent) 20%, var(--surface));
		border-color: var(--accent);
	}
	.mgr-conflict-btn--proxy {
		background: color-mix(in srgb, var(--proxy) 10%, var(--surface));
		border-color: color-mix(in srgb, var(--proxy) 35%, transparent);
		color: var(--proxy);
	}
	.mgr-conflict-btn--proxy:hover {
		background: color-mix(in srgb, var(--proxy) 18%, var(--surface));
		border-color: var(--proxy);
	}

	.mgr-foil {
		font-size: 10px;
		color: var(--text-muted);
	}
	.mgr-current {
		color: var(--accent);
	}
</style>
