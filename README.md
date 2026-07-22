# MTG Collection Manager

A local-first manager for a physical Magic: The Gathering collection. It tracks individual card
copies, operational deck assignments, packing and returns, shopping/orders, and legitimate printed
proxy inventory. Decklists can be imported or synchronized from Moxfield, but this is not a deck
builder or recommendation engine.

The application runs locally on your computer and opens in your web browser. No hosted database,
account, API key, or other secret is required.

**Project status:** This project is maintained primarily for personal use and shared publicly for
others who may find it useful. It is not abandoned, but updates and maintainer availability may be
irregular. Bug reports, suggestions, and pull requests are welcome. Review, response, or inclusion
in a release is not guaranteed.

## Requirements

- Node.js 20.19 or newer; Node.js 22 LTS is recommended
- An internet connection for the initial dependency install and optional Scryfall metadata download
- Roughly 1 GB of temporary free space while building the Scryfall cache

## Quick start

Download or clone this project, then use the launcher for your operating system.

### Windows

Double-click `start.bat`, or run it from PowerShell/Command Prompt:

```bat
start.bat
```

### macOS or Linux

From a terminal in the project directory:

```sh
sh start.sh
```

### Phones and tablets on the same Wi-Fi

Use the separate LAN launcher when you want to connect another device:

```bat
start-lan.bat
```

or on macOS/Linux:

```sh
sh start-lan.sh
```

The dashboard displays the detected local-network address and a QR code. Connect the other device
to the same trusted Wi-Fi network, then scan the code. Windows may ask whether Node.js can
communicate on private networks the first time; allow private networks only.

LAN mode has no login. Anyone who can reach the address can view or modify application data. Do not
use it on an untrusted network, enable router port forwarding, or expose it to the public internet.

The launcher checks Node.js, installs or verifies dependencies, creates or migrates the local
collection database, builds the local server, starts it, and opens the application in your default
browser. When Scryfall metadata is missing or more than seven days old, it first offers to download
and rebuild it. It separately offers the optional Oracle-tag refresh when tags are missing or more
than 30 days old. Both downloads require confirmation; declining them does not prevent startup.
Later launches repeat the safety checks without deleting or replacing your personal data.

By default the application is available at <http://127.0.0.1:5173>. Keep the launcher terminal open
while using it. Press `Ctrl+C` in that terminal to stop the application.

If pnpm is not already available, the launcher uses Corepack when present. Otherwise install pnpm
once with:

```sh
npm install --global pnpm
```

## First-run setup

The dashboard walks through three local setup steps:

1. `collection.db` is created and migrated automatically.
2. Open **Scryfall Cache** and choose **Set up local cache**. This downloads roughly 500 MB,
   builds `scryfall.db`, and removes the temporary download afterward.
3. Import a Moxfield collection CSV or a collection CSV previously exported by this application.

Collection imports always show a preview. **Merge/update** is the recommended non-destructive mode.
**Synchronize** can remove entries absent from the file, while protecting actively assigned copies.
**Full replace** wipes collection entries and unlinks physical assignments, so use it only when you
intend to start over.

Oracle tags are optional. Their source endpoint is undocumented and best-effort; failure to refresh
them does not prevent normal collection management.

The reminder ages can be changed with `SCRYFALL_MAX_AGE_DAYS` and `ORACLE_TAG_MAX_AGE_DAYS` in
`.env`. Set `METADATA_PROMPT=0` to disable startup metadata prompts entirely.

Browser form and CSV uploads are limited to 25 MB by default. Set `BODY_SIZE_LIMIT` in `.env` if a
legitimate import needs a different bounded limit.

## How the collection is organized

The default setup reflects the physical filing system the application was created for. Cards are
first assigned to a storage location:

- Cards worth $10 or more go in the **$10+ Binder** by default.
- Monocolored cards go in the matching **White**, **Blue**, **Black**, **Red**, or **Green Box**.
- Cards with more than one color in their mana cost go in the **Multicolor Box**.
- Cards without colored mana symbols go in the **Colorless Box**.
- Lands go in the **Land Box**.
- Printed proxies are tracked separately in the **Proxy Deckbox**.
- New, unfiled, and returned real cards can be placed temporarily in the **Holding Box**.

These are computed locations, not requirements. A card can be given a manual location override,
and the binder price threshold can be changed in **Settings**.

### Storage buckets

Inside each colored or colorless box, the Pick List groups cards in this order: creatures and
planeswalkers, instants, sorceries, enchantments, Auras, Enchantment+, artifacts, Equipment,
Vehicles, and lands. Each type is then divided into mana-value ranges and sorted alphabetically.
For example, a box might have separate creature sections for mana values `0–1`, `2`, `3`, `4`, and
`5+`.

The default ranges in **Settings → Storage Buckets** match the original collection's physical
dividers. They are deliberately more detailed for large sections and use a single **All** bucket
for smaller ones. Adjust them to match your own boxes and dividers; the Pick List updates to use
the same arrangement.

**Enchantment+** is the catch-all section for special enchantment-style card types that are not
filed with ordinary enchantments or Auras. It includes Sagas, Classes, Rooms, Battles, and similar
cards. It exists so those unusual frames and card types can have their own physical divider.

Storage-bucket settings are saved in the current browser, not in `collection.db`. A phone or a
different browser may therefore have its own bucket configuration, and the JSON application backup
does not currently include it. The collection locations and manual overrides themselves are stored
in the database and are backed up.

## How the workflow fits together

The application separates inventory planning from the physical act of putting cards into decks:

1. **Collection** records the real printings and quantities you own. Import a CSV, add cards
   manually, or use the Holding Box while new cards are waiting to be filed.
2. **Decks** holds imported decklists. The Manager assigns each deck slot to a real collection copy,
   a printed proxy, a card that is still needed, or an ordered card. It also tracks whether the
   assigned card has physically been pulled and packed.
3. **Missing** shows cards used by active decks when the collection owns no copies at all. It is a
   quick answer to “which card names do I not own?” rather than an assignment report.
4. **Shortfalls** compares the total copies required across active decklists with the total owned.
   If four active decks need a card and the collection owns one, the shortfall is three. This is
   useful for acquisition planning even before individual copies have been assigned.
5. **Shopping List** is a manually controlled planning list. Add cards from Missing or Shortfalls,
   or add them directly; then adjust quantities and notes before deciding what to buy.
6. **Orders** tracks purchases that have actually been placed. Shopping-list entries can be moved
   here, and arriving cards can be added to the collection.
7. **Pick List** is the physical retrieval view. It gathers assigned real cards and proxies for the
   selected active decks, groups them in the same order as the storage boxes and buckets, and lets
   you mark cards pulled or packed as you find them.
8. **Returns** handles cards released by a deck synchronization. Real cards are routed to the
   Holding Box and proxies to the Proxy Deckbox so the physical cards can be put away deliberately.
9. **Archive** removes a deck from active planning and unassigns its cards without erasing the
   decklist. Archived decks no longer contribute to Missing, Shortfalls, or active pull workflows.

Basic lands are hidden from Missing and Shortfalls by default because most collections do not need
to acquire them per deck. They remain visible in deck views, and the preference can be changed in
**Settings**.

The application does not build decks or recommend cards. Deck import and synchronization exist to
support physical inventory, proxy, purchasing, picking, and return workflows.

## Local data and backups

- `collection.db` contains personal collection data, operational decks and assignments, printed
  proxies, orders, and the shopping list.
- `scryfall.db` contains rebuildable card metadata and optional Oracle tags.
- Both databases and their WAL/SHM files are excluded by `.gitignore`.
- Use **Settings → Download backup** to export personal application data as JSON.
- Restore replaces all current personal application data and requires explicit confirmation.
  Scryfall metadata is not included because it can be downloaded again.

Download backups regularly. The data is local and is not automatically copied to a cloud service.
A practical routine is to download one after a large collection import or filing session, before an
application update, and before attempting a restore. If the collection changes frequently, also
keep a weekly backup; otherwise a monthly backup may be sufficient. Store the JSON files somewhere
outside the application folder, ideally in a backed-up cloud folder or on another drive, and retain
more than one dated copy.

The backup includes collection inventory, decks and deck cards, assignments, pending deck returns
and synchronization changes, printed-proxy inventory, the Shopping List, and Orders. It does not
include the rebuildable Scryfall cache, optional Oracle tags, or browser-local Storage Bucket
settings.

To store either database elsewhere, copy `.env.example` to `.env` and set absolute or
project-relative paths:

```dotenv
COLLECTION_DB_PATH=./collection.db
SCRYFALL_DB_PATH=./scryfall.db
```

## Updating

Replace the application files with a newer release or pull the latest source, then run the launcher
again. It installs updated dependencies and applies checked-in collection migrations before the
server starts. Back up `collection.db` from Settings before a major update.

## Developer commands

```sh
pnpm install             # install dependencies
pnpm dev                 # development server with hot reload
pnpm start               # migrate, build, start, and open the local production server
pnpm run setup           # apply collection.db migrations only
pnpm test                # run unit tests
pnpm check               # run Svelte and TypeScript checks
pnpm lint                # check formatting and lint rules
pnpm build               # create the standalone Node server in build/
pnpm scryfall:download   # download Scryfall Default Cards to the project root
pnpm scryfall:seed       # rebuild scryfall.db from that downloaded file
pnpm scryfall:tags       # best-effort optional Oracle-tag refresh
```

Set `NO_OPEN=1` to start without opening a browser. `HOST` and `PORT` may override the default
`127.0.0.1:5173` listener.

## Troubleshooting

- **Unsupported Node.js version:** install Node.js 22 LTS, close and reopen the terminal, then run
  the launcher again.
- **pnpm not found:** run `npm install --global pnpm`, then retry.
- **Port 5173 already in use:** set another port before starting (`$env:PORT=5174` in PowerShell or
  `PORT=5174 sh start.sh` on macOS/Linux).
- **Database cannot be initialized:** confirm the project or configured database directory is
  writable and that the `drizzle/` directory is present.
- **413 Payload Too Large:** restart through the current launcher, which permits bounded uploads up
  to 25 MB by default. Increase `BODY_SIZE_LIMIT` in `.env` only when a legitimate CSV requires it.
- **Scryfall setup interrupted:** return to Scryfall Cache and run setup again. Partial downloads are
  discarded; an existing completed cache remains local.
- **Browser did not open:** visit <http://127.0.0.1:5173> manually while the launcher is running.

## Contributing

Improvements are welcome. For substantial changes, please open an issue first so the idea can be
checked against the project's scope before you invest significant effort. Pull requests should
remain focused, preserve the local-first design, and comply with the project's noncommercial
license. Contributions may take time to review and are not guaranteed to be merged.

## License

This source is available under the [PolyForm Noncommercial License 1.0.0](LICENSE). It is free for
personal and other permitted noncommercial use. Commercial use is not permitted without separate
written permission from the project owner.

## Data sources and attribution

Card names, images, prices, rules text, and related metadata are provided by
[Scryfall](https://scryfall.com/docs/api). This project is not produced by, endorsed by, supported
by, or affiliated with Wizards of the Coast. Magic: The Gathering and its marks are property of
Wizards of the Coast.
