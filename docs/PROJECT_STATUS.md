# Project Status

Last updated: July 22, 2026

## Current scope

MTG Collection Manager is a local-first application for managing a physical Magic: The Gathering
collection. It supports collection imports, card locations, operational deck assignments, printed
proxy inventory, pull and return workflows, shortage planning, shopping, and order tracking.

Decklists can be imported or synchronized from Moxfield. The application uses them to coordinate
physical inventory; it does not author decks or recommend cards.

## Local data

- Personal application data is stored in an ignored local `collection.db` SQLite database.
- Rebuildable Scryfall card metadata and optional Oracle tags are stored separately in ignored
  `scryfall.db`.
- No hosted service, account, API key, or application secret is required.
- Both databases, sidecar files, exports, backups, and environment overrides are excluded by
  `.gitignore`.
- Settings can download and restore versioned JSON backups of personal application data.
- Storage Bucket configuration is browser-local and is not currently included in JSON backups.

## Setup and use

- `start.bat` and `start.sh` provide local-only startup.
- `start-lan.bat` and `start-lan.sh` provide optional access from another device on the same trusted
  network, with the address and QR code shown on the dashboard.
- Launchers check Node.js, install dependencies, migrate `collection.db`, build the server, and open
  the application.
- Missing or stale Scryfall metadata prompts for an optional download and local rebuild.
- Optional Oracle tags are best-effort and never prevent normal startup.
- Browser form and CSV bodies have a configurable bounded size limit, defaulting to 25 MB.

## Documentation

- `README.md` covers installation, first-run setup, storage organization, normal workflows, LAN
  access, updates, troubleshooting, backups, contribution expectations, and licensing.
- The in-app Help page explains Storage Buckets, Enchantment+, Missing and Shortfalls, Shopping List
  and Orders, Deck Manager and Pick List, Returns, proxies, backups, and LAN access.
- Contextual Help links are available from Shortfalls, Pick List, Deck Manager, Returns, and Storage
  Bucket settings.

## Validation

Latest validation on July 22, 2026:

- Prettier: passed.
- ESLint: passed.
- Unit tests: 255/255 passed across 16 files.
- Svelte and TypeScript diagnostics: 0 errors and 0 warnings.
- Production build: passed.
- Clean-copy setup: a database-free copy installed from the lockfile, applied migrations to a new
  `collection.db`, and completed a production build. `scryfall.db` remained optional until metadata
  setup.
- Static audit: no credentials, personal filesystem paths, unsupported inventory terminology, or
  obsolete hosted-service implementation was found in application source.
- Public-file audit: the intended source, documentation, migration, launcher, license, and
  configuration files were reviewed. Local databases, dependency directories, build output,
  caches, and agent workspace files remain excluded by `.gitignore`.

## Before publishing

- Complete one final hands-on workflow using non-personal sample data: collection import, deck
  import/sync, assignment, picking, shopping/order receipt, returns, backup download, and backup
  restore.
- Review the intended public file set one final time before creating repository history.
- Do not include real databases, collection exports, backups, environment files, build output, or
  dependency directories.
- The local Git repository is initialized on `main`; the initial commit and public remote remain
  intentionally pending until the owner approves publication.

## Maintenance posture

The project is maintained primarily for personal use and shared for others who may find it useful.
It is not abandoned, but releases and maintainer availability may be irregular. Focused bug reports,
suggestions, and pull requests are welcome; review or inclusion is not guaranteed.

The project uses the PolyForm Noncommercial License 1.0.0. Commercial use requires separate written
permission from the project owner.
