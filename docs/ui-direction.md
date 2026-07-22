# UI Direction

## Current design direction

Current direction: **Moxfield/Scryfall-inspired collection manager**.

The app should feel like:

- a serious MTG physical collection manager
- dense, practical, and scannable
- closer to Moxfield/Scryfall than a generic SaaS dashboard
- built for repeated daily use
- focused on managing physical cards, deck assignments, printed proxies, shopping needs, and shortfalls

Avoid:

- generic SaaS dashboard styling
- emoji UI
- gradients
- huge rounded cards
- excessive stat cards
- playful/fantasy theming
- passive views that look nice but do not let the user act
- overly soft/beige/card-catalog colors
- weak status indicators that require decoding

## Theme direction

The warm Card Catalog palette was tried, but it felt too beige/soft.

Use a cooler Moxfield/Scryfall-style palette instead:

- light mode: clean white / very light cool gray
- dark mode: deep navy / charcoal
- surfaces: white or pale blue-gray in light mode, dark charcoal/navy in dark mode
- borders: cool gray-blue
- text: high contrast dark neutral or off-white
- muted text: readable medium gray, not washed out
- accent: purple/indigo, closer to Moxfield/Scryfall than generic startup blue

Semantic colors:

- green = pulled / owned
- amber = needed / missing / needs copy
- violet = proxy
- blue = assigned / info
- red = destructive
- gray = ordered / inactive / secondary

## Core UX principle

The deck detail page should not separate “viewing the deck” from “managing the deck.”

The primary deck detail workflow should combine:

- seeing the deck grouped by type
- seeing each card’s current status
- managing pull/assign/proxy/order actions directly from the row

## Deck detail views

### Manager view

Manager view is the new default deck detail view.

It should be:

- condensed
- grouped by card type
- actionable
- scannable at a glance
- closer to Moxfield’s deck editor interaction model, but using this app’s own restrained style

Manager groups:

- Commander
- Creatures & Planeswalkers
- Instants
- Sorceries
- Enchantments
- Artifacts
- Equipment
- Lands
- Rooms & Battles
- Side/Maybe, where relevant

Manager row should show:

- strong status marker
- card name as the visual anchor
- set/source/copy info
- location or state
- primary action if relevant
- row menu for secondary actions

Status should be visually primary. Do not rely only on tiny dots.

The user should be able to immediately identify:

- pulled
- assigned
- needed
- missing
- proxy
- ordered
- needs copy

### Table view

Table view remains the spreadsheet/admin view.

It can be wider and more detailed, but it should not be the default workflow.

### Decklist view

Decklist remains a passive text/copy view.

### Visual view

Visual remains a passive card-image gallery.

### Board view

Board view is legacy/passive. It may remain temporarily, but Manager view is intended to replace it.

## Terminology

Only legitimate printed proxies are supported. Keep them clearly labeled and separate from owned
collection cards.

## Product concepts

### Missing

Missing means:

> collection quantity equals 0 and the card appears in one or more decklists.

Do not use assigned quantity or deck usage count to decide if something is Missing.

Rule:

```ts
collectionQty === 0;
```

### Shortfalls

Shortfalls means:

> collection quantity is less than the number of decklists using that card.

Example:

> Own 1 Sol Ring, but Sol Ring appears in 4 decklists = shortfall of 3.

Shortfalls are for deciding whether to buy more copies or print proxies.

### Shopping List

Shopping List is manually curated.

It is different from Missing and different from Orders.

- Missing = computed from collection quantity
- Shortfalls = computed from deck usage vs collection quantity
- Shopping List = cards the user may want to buy/proxy/order later
- Orders = cards actually ordered or being tracked as ordered

## Navigation

The left sidebar should remain the primary navigation pattern.

Do not replace it with a horizontal top nav. The app has too many sections for top nav to scale well.

Preferred direction:

- collapsible desktop sidebar
- narrow rail when collapsed
- drawer/hamburger behavior on small screens if practical
- top bar reserved for page-level actions, not main navigation
