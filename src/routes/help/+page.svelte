<svelte:head>
	<title>Help · MTG Collection Manager</title>
	<meta
		name="description"
		content="How collection storage, decks, shortfalls, shopping, picking, returns, proxies, and backups work."
	/>
</svelte:head>

<div class="page-header">
	<div>
		<h1 class="page-title">How it works</h1>
		<p class="page-subtitle">A practical guide to organizing and using your physical collection.</p>
	</div>
</div>

<nav class="help-index" aria-label="Help topics">
	<a href="#start">Start here</a>
	<a href="#storage">Storage</a>
	<a href="#planning">Missing &amp; Shortfalls</a>
	<a href="#shopping">Shopping &amp; Orders</a>
	<a href="#decks">Decks &amp; Pick List</a>
	<a href="#returns">Returns</a>
	<a href="#proxies">Proxies</a>
	<a href="#backups">Backups</a>
	<a href="#lan">Phone access</a>
</nav>

<div class="help-content">
	<section id="start" class="card help-section">
		<h2>Start here</h2>
		<ol>
			<li>
				Set up the <a href="/collection/scryfall">Scryfall Cache</a> so the app knows card printings,
				types, prices, and images.
			</li>
			<li>
				Add your cards through <a href="/collection/import">Import Collection</a> or add them
				manually from <a href="/collection">Collection</a>.
			</li>
			<li>
				<a href="/decks/new">Import a decklist</a>, then use its Manager to decide which real cards
				or printed proxies will fill its slots.
			</li>
			<li>
				Use the <a href="/picklist">Pick List</a> to retrieve those cards from your physical storage and
				mark them pulled.
			</li>
		</ol>
		<p>
			This is an inventory and deck-operations tool. It tracks where physical cards are and what
			each deck needs; it does not build decks or recommend cards.
		</p>
	</section>

	<section id="storage" class="card help-section">
		<h2>Storage locations and buckets</h2>
		<p>The default physical organization is:</p>
		<ul>
			<li><strong>$10+ Binder:</strong> cards at or above the price threshold.</li>
			<li><strong>W/U/B/R/G Boxes:</strong> cards with one color in their mana cost.</li>
			<li><strong>Multicolor Box:</strong> cards with more than one mana color.</li>
			<li><strong>Colorless Box:</strong> cards without colored mana symbols.</li>
			<li><strong>Land Box:</strong> lands.</li>
			<li><strong>Proxy Deckbox:</strong> legitimate printed proxies.</li>
			<li><strong>Holding Box:</strong> new, returned, or unfiled real cards awaiting filing.</li>
		</ul>
		<p>
			Locations are calculated automatically, but you can override a card's location. Change the
			binder threshold in <a href="/settings">Settings</a>.
		</p>

		<h3>What is a storage bucket?</h3>
		<p>
			Inside each box, cards are grouped by type, then by configurable mana-value ranges, then
			alphabetically. For example, the White Box can have creature dividers for mana values
			<strong>0–1</strong>, <strong>2</strong>, <strong>3</strong>, <strong>4</strong>, and
			<strong>5+</strong>. The Pick List follows those same dividers so you can walk through a box
			in order.
		</p>
		<p>
			The default buckets match the original collection's physical organization. You can adapt them
			under <a href="/settings#bucket-config">Settings → Storage Buckets</a> to match your own boxes.
		</p>

		<h3>What is Enchantment+?</h3>
		<p>
			<strong>Enchantment+</strong> is the physical section for special enchantment-style cards that are
			not filed as ordinary enchantments or Auras. It includes Sagas, Classes, Rooms, Battles, and similar
			cards. Giving them their own divider makes unusual frames and card types easier to find.
		</p>
		<div class="help-note">
			Bucket configuration is stored in this browser. A phone or another browser can have different
			bucket settings, and these settings are not included in application backups. Card locations
			and manual overrides are stored in the database and are backed up.
		</div>
	</section>

	<section id="planning" class="card help-section">
		<h2>Missing and Shortfalls</h2>
		<div class="comparison">
			<div>
				<h3><a href="/missing">Missing</a></h3>
				<p>
					Cards used by an active deck when you own no copies at all. This answers “Which card names
					don't I own?”
				</p>
			</div>
			<div>
				<h3><a href="/shortfalls">Shortfalls</a></h3>
				<p>
					The difference between copies required across all active decks and copies owned. If four
					decks use a card and you own one, the shortfall is three.
				</p>
			</div>
		</div>
		<p>
			These are inventory-planning views; they do not depend on whether copies have been physically
			pulled. Basic lands are hidden by default and can be enabled in <a href="/settings"
				>Settings</a
			>.
		</p>
	</section>

	<section id="shopping" class="card help-section">
		<h2>Shopping List and Orders</h2>
		<p>
			The <a href="/shopping-list">Shopping List</a> is a manually controlled plan. Add cards from Missing
			or Shortfalls—or add them directly—then adjust quantities and notes. Nothing is added automatically
			just because a shortage exists.
		</p>
		<p>
			<a href="/orders">Orders</a> represents purchases you have actually placed. Move an item there when
			you buy it, record its source and notes, and mark it arrived when it reaches you. Arriving cards
			can be added to Collection.
		</p>
	</section>

	<section id="decks" class="card help-section">
		<h2>Deck Manager and Pick List</h2>
		<p>
			<a href="/decks">Decks</a> stores imported or synchronized decklists. In a deck's Manager, each
			slot can be assigned to a real collection copy, a printed proxy, a card that is needed, or a card
			that has been ordered. The pulled state records whether the selected physical card is already packed
			in the deck.
		</p>
		<p>
			The <a href="/picklist">Pick List</a> turns those decisions into a physical retrieval list. Choose
			the decks and statuses you want, then work through cards grouped by location, type, mana-value bucket,
			and name. Marking a card pulled keeps the Manager and dashboard in sync.
		</p>
		<p>
			Archiving a deck unassigns its cards and removes it from active planning without erasing its
			decklist. It no longer contributes to Missing, Shortfalls, or active picking.
		</p>
	</section>

	<section id="returns" class="card help-section">
		<h2>Returns</h2>
		<p>
			When synchronizing a deck removes cards or lowers quantities, the app creates a
			<a href="/returns">Returns</a> queue instead of silently forgetting where assigned copies went.
			Real cards are routed to the Holding Box; proxies return to the Proxy Deckbox. Complete the return
			after physically removing the cards, then file Holding Box cards from Collection.
		</p>
	</section>

	<section id="proxies" class="card help-section">
		<h2>Printed proxies</h2>
		<p>
			<a href="/proxies">Proxies</a> tracks legitimate physical printed-proxy inventory separately from
			real owned cards. A printed proxy can be reserved for a deck, assigned, pulled, returned, or marked
			as needing printing or reprinting. A proxy that already has a linked printed copy does not count
			as still needing to print.
		</p>
	</section>

	<section id="backups" class="card help-section important">
		<h2>Back up your data regularly</h2>
		<p>
			Your data lives only on this computer and is <strong>not backed up automatically</strong>. Use
			<a href="/settings">Settings → Download backup</a> after large imports or filing sessions, before
			application updates, and before restoring another backup. If you use the app often, keep a weekly
			backup; otherwise, a monthly backup may be enough.
		</p>
		<p>
			Store several dated JSON backups outside the application folder—preferably in a backed-up
			cloud folder or on another drive. The export includes collection data, decks, assignments,
			returns, printed proxies, Shopping List, and Orders. Rebuildable Scryfall data, Oracle tags,
			and browser-local bucket settings are not included.
		</p>
		<p>
			Restoring a backup replaces the current personal application data. Download a fresh backup
			first and read the confirmation carefully.
		</p>
	</section>

	<section id="lan" class="card help-section">
		<h2>Using a phone or tablet</h2>
		<p>
			Start with <code>start-lan.bat</code> on Windows or <code>sh start-lan.sh</code> on macOS/Linux.
			The dashboard shows a local-network address and QR code for devices on the same Wi-Fi.
		</p>
		<div class="help-note warning">
			LAN mode has no login. Use it only on a trusted private network. Do not forward its port or
			expose it to the public internet.
		</div>
	</section>
</div>

<style>
	.help-index {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 18px;
	}

	.help-index a {
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		font-size: 13px;
		text-decoration: none;
	}

	.help-content {
		display: grid;
		gap: 16px;
		max-width: 900px;
	}

	.help-section {
		scroll-margin-top: 18px;
	}

	.help-section h2 {
		margin: 0 0 12px;
		font-size: 19px;
	}

	.help-section h3 {
		margin: 18px 0 6px;
		font-size: 15px;
	}

	.help-section p,
	.help-section li {
		line-height: 1.6;
	}

	.help-section p:last-child,
	.help-section ul:last-child,
	.help-section ol:last-child {
		margin-bottom: 0;
	}

	.help-section li + li {
		margin-top: 5px;
	}

	.comparison {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.comparison > div,
	.help-note {
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-raised);
	}

	.comparison h3 {
		margin-top: 0;
	}

	.comparison p {
		margin-bottom: 0;
	}

	.help-note {
		margin-top: 14px;
		font-size: 13px;
		line-height: 1.55;
	}

	.help-note.warning,
	.important {
		border-color: color-mix(in srgb, var(--warning) 45%, var(--border));
	}

	code {
		font-size: 0.9em;
	}

	@media (max-width: 640px) {
		.comparison {
			grid-template-columns: 1fr;
		}
	}
</style>
