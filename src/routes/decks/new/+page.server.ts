import type { PageServerLoad, Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db/index';
import { decks, deckCards, cardAssignments, collection } from '$lib/server/db/schema';
import { parseTextDecklist, fetchMoxfieldDeck } from '$lib/server/moxfield';
import { enrichByIdentifiers, enrichByName } from '$lib/server/scryfall';
import { getByName as scryfallByName } from '$lib/server/db/scryfall-sqlite';
import { eq, and, count } from 'drizzle-orm';
import type { ParsedDeckCard } from '$lib/types';

export const load: PageServerLoad = async () => {
	return {};
};

async function importDeck(
	cards: ParsedDeckCard[],
	meta: {
		name: string;
		format?: string | null;
		commander?: string | null;
		moxfieldUrl?: string | null;
	}
) {
	const now = Date.now();

	const [deck] = await db
		.insert(decks)
		.values({
			name: meta.name,
			format: meta.format ?? null,
			commander: meta.commander ?? null,
			moxfieldUrl: meta.moxfieldUrl ?? null,
			sourceMode: meta.moxfieldUrl ? 'moxfield' : 'local',
			createdAt: now,
			updatedAt: now
		})
		.returning();
	const deckId = deck.id;

	// Enrich cards with Scryfall data where set+collector is available
	const identifiers = cards
		.filter((c) => c.setCode && c.collectorNumber)
		.map((c) => ({ setCode: c.setCode!, collectorNumber: c.collectorNumber! }));

	await enrichByIdentifiers(identifiers).catch((e) =>
		console.error('Scryfall enrichment error:', e)
	);

	// For cards without set/collector, try enriching by name
	const needNameLookup = cards.filter((c) => !c.setCode || !c.collectorNumber);
	for (const card of needNameLookup) {
		// Check SQLite cache before hitting the API
		const existing = scryfallByName(card.cardName);
		if (!existing) {
			await enrichByName(card.cardName).catch(() => null);
		}
	}

	// Insert deck cards and create assignments
	for (const card of cards) {
		const [dc] = await db
			.insert(deckCards)
			.values({
				deckId,
				cardName: card.cardName,
				quantity: card.quantity,
				setCode: card.setCode ?? null,
				collectorNumber: card.collectorNumber ?? null,
				board: card.board,
				isCommander: card.isCommander
			})
			.returning();

		// Auto-assign from collection — only on exact set+collector match.
		// Name-only fallback intentionally removed: assigning the wrong printing is
		// more confusing than leaving it as 'needed' for the user to pick manually.
		for (let copyIdx = 0; copyIdx < card.quantity; copyIdx++) {
			let collectionId: number | null = null;
			let status = 'needed';

			if (!card.setCode || !card.collectorNumber) {
				// No set+collector info — skip auto-assign, user picks manually
				await db.insert(cardAssignments).values({
					deckCardId: dc.id,
					deckId,
					cardName: card.cardName,
					collectionId: null,
					status: 'needed',
					proxySetCode: null,
					proxyCollectorNumber: null
				});
				continue;
			}

			const matchQuery = and(
				eq(collection.name, card.cardName),
				eq(collection.setCode, card.setCode),
				eq(collection.collectorNumber, card.collectorNumber)
			);

			const available = await db
				.select({
					id: collection.id,
					quantity: collection.quantity,
					locationOverride: collection.locationOverride
				})
				.from(collection)
				.where(matchQuery)
				.limit(10);

			for (const entry of available) {
				const [{ cnt }] = await db
					.select({ cnt: count() })
					.from(cardAssignments)
					.where(
						and(eq(cardAssignments.collectionId, entry.id), eq(cardAssignments.status, 'assigned'))
					);

				if (entry.quantity - cnt > 0) {
					collectionId = entry.id;
					status = 'assigned';
					break;
				}
			}

			await db.insert(cardAssignments).values({
				deckCardId: dc.id,
				deckId,
				cardName: card.cardName,
				collectionId,
				status,
				proxySetCode: null,
				proxyCollectorNumber: null
			});
		}
	}

	// After all cards are inserted, update commander from isCommander cards
	const commanderCards = await db
		.select({ cardName: deckCards.cardName })
		.from(deckCards)
		.where(and(eq(deckCards.deckId, deckId), eq(deckCards.isCommander, true)));
	if (commanderCards.length > 0) {
		const commanderStr = commanderCards.map((c) => c.cardName).join(' / ');
		await db.update(decks).set({ commander: commanderStr }).where(eq(decks.id, deckId));
	}

	return deckId;
}

export const actions: Actions = {
	importText: async ({ request }) => {
		const data = await request.formData();
		const name = ((data.get('name') as string) ?? '').trim();
		const text = ((data.get('decklist') as string) ?? '').trim();
		const existingDeckId = data.get('existingDeckId')
			? parseInt(data.get('existingDeckId') as string)
			: undefined;
		const createAnyway = data.get('createAnyway') === 'true';

		if (!name) return fail(400, { error: 'Deck name is required.', tab: 'text' });
		if (!text) return fail(400, { error: 'Decklist is required.', tab: 'text' });
		if (existingDeckId) {
			return fail(409, {
				error:
					'Replacing an existing deck is disabled to protect its assignments. Open the deck to manage it.',
				tab: 'text'
			});
		}

		const cards = parseTextDecklist(text);
		if (cards.length === 0) {
			return fail(400, { error: 'No cards parsed from decklist.', tab: 'text' });
		}

		const format = ((data.get('format') as string) ?? '').trim() || null;
		const commander =
			cards
				.filter((c) => c.isCommander)
				.map((c) => c.cardName)
				.join(' / ') || null;

		// Duplicate check (skip if overwriting or user confirmed)
		if (!existingDeckId && !createAnyway) {
			const [existing] = await db
				.select({ id: decks.id, name: decks.name })
				.from(decks)
				.where(eq(decks.name, name))
				.limit(1);
			if (existing) {
				return {
					duplicate: true,
					existingId: existing.id,
					existingName: existing.name,
					name,
					format,
					decklist: text,
					tab: 'text'
				};
			}
		}

		try {
			const deckId = await importDeck(cards, { name, format, commander, moxfieldUrl: null });
			redirect(303, `/decks/${deckId}`);
		} catch (e) {
			if (e && typeof e === 'object' && 'location' in e) throw e;
			return fail(500, { error: String(e), tab: 'text' });
		}
	},

	importMoxfieldBulk: async ({ request }) => {
		const data = await request.formData();
		const raw = ((data.get('urls') as string) ?? '').trim();

		const urls = raw
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.includes('moxfield.com/decks/'));

		if (urls.length === 0) {
			return fail(400, { error: 'No valid Moxfield deck URLs found.', tab: 'bulk' });
		}

		type BulkResult = {
			url: string;
			name?: string;
			status: 'imported' | 'skipped' | 'error';
			error?: string;
			deckId?: number;
		};
		const results: BulkResult[] = [];

		for (const url of urls) {
			// Skip if already imported by URL
			const [existing] = await db
				.select({ id: decks.id, name: decks.name })
				.from(decks)
				.where(eq(decks.moxfieldUrl, url))
				.limit(1);
			if (existing) {
				results.push({ url, name: existing.name, status: 'skipped' });
				continue;
			}

			let parsed;
			try {
				parsed = await fetchMoxfieldDeck(url);
			} catch (e) {
				results.push({ url, status: 'error', error: `Fetch failed: ${e}` });
				continue;
			}

			try {
				const deckId = await importDeck(parsed.cards, {
					name: parsed.name,
					format: parsed.format,
					commander: parsed.commander,
					moxfieldUrl: url
				});
				results.push({ url, name: parsed.name, status: 'imported', deckId });
			} catch (e) {
				results.push({ url, name: parsed.name, status: 'error', error: String(e) });
			}
		}

		return { bulkResults: results, tab: 'bulk' };
	},

	importMoxfield: async ({ request }) => {
		const data = await request.formData();
		const url = ((data.get('url') as string) ?? '').trim();
		const existingDeckId = data.get('existingDeckId')
			? parseInt(data.get('existingDeckId') as string)
			: undefined;
		const createAnyway = data.get('createAnyway') === 'true';

		if (!url) return fail(400, { error: 'Moxfield URL is required.', tab: 'moxfield' });
		if (existingDeckId) {
			return fail(409, {
				error: 'Replacing an existing deck is disabled. Open the deck and use Sync instead.',
				tab: 'moxfield'
			});
		}
		if (!url.includes('moxfield.com/decks/')) {
			return fail(400, { error: 'Not a valid Moxfield deck URL.', tab: 'moxfield' });
		}

		let parsed;
		try {
			parsed = await fetchMoxfieldDeck(url);
		} catch (e) {
			return fail(500, { error: `Failed to fetch deck: ${e}`, tab: 'moxfield' });
		}

		// Duplicate check (skip if overwriting or user confirmed)
		if (!existingDeckId && !createAnyway) {
			const [existing] = await db
				.select({ id: decks.id, name: decks.name })
				.from(decks)
				.where(eq(decks.moxfieldUrl, url))
				.limit(1);
			if (existing) {
				return {
					duplicate: true,
					existingId: existing.id,
					existingName: existing.name,
					url,
					tab: 'moxfield'
				};
			}
		}

		try {
			const deckId = await importDeck(parsed.cards, {
				name: parsed.name,
				format: parsed.format,
				commander: parsed.commander,
				moxfieldUrl: url
			});
			redirect(303, `/decks/${deckId}`);
		} catch (e) {
			if (e && typeof e === 'object' && 'location' in e) throw e;
			return fail(500, { error: String(e), tab: 'moxfield' });
		}
	}
};
