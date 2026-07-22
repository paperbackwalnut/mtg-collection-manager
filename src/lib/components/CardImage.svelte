<script lang="ts">
	let {
		imageUri,
		backImageUri = null,
		name,
		children
	}: {
		imageUri: string | null;
		backImageUri?: string | null;
		name: string;
		children?: any;
	} = $props();

	let show = $state(false);
	let tx = $state(0);
	let ty = $state(0);

	const CARD_W = 180;
	const GAP = 4;

	function tooltipWidth() {
		return backImageUri ? CARD_W * 2 + GAP : CARD_W;
	}

	function enter(e: MouseEvent) {
		show = true;
		move(e);
	}
	function leave() {
		show = false;
	}
	function move(e: MouseEvent) {
		const w = tooltipWidth();
		let x = e.clientX + 16;
		let y = e.clientY - 140;
		if (typeof window !== 'undefined') {
			if (x + w > window.innerWidth - 8) x = e.clientX - w - 16;
			if (y < 8) y = 8;
			if (y + 280 > window.innerHeight) y = window.innerHeight - 288;
		}
		tx = x;
		ty = y;
	}
</script>

<span
	style="cursor:default;display:inline"
	onmouseenter={enter}
	onmouseleave={leave}
	onmousemove={move}
	role="presentation"
>
	{@render children?.()}
</span>
{#if show && imageUri}
	{#if backImageUri}
		<div
			style="position:fixed;top:{ty}px;left:{tx}px;display:flex;gap:{GAP}px;z-index:999;pointer-events:none"
		>
			<img
				src={imageUri}
				alt={name}
				style="width:{CARD_W}px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.6)"
			/>
			<img
				src={backImageUri}
				alt="{name} (back)"
				style="width:{CARD_W}px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.6)"
			/>
		</div>
	{:else}
		<img
			src={imageUri}
			alt={name}
			style="position:fixed;top:{ty}px;left:{tx}px;width:{CARD_W}px;border-radius:10px;z-index:999;box-shadow:0 8px 30px rgba(0,0,0,0.6);pointer-events:none"
		/>
	{/if}
{/if}
