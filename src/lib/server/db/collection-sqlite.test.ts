import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { cardAssignments, deckCards, decks } from './schema';

const fixtureDir = mkdtempSync(join(tmpdir(), 'mtg-collection-db-'));
process.env.COLLECTION_DB_PATH = join(fixtureDir, 'collection.db');

let database: Awaited<typeof import('./index')>;

beforeAll(async () => {
	database = await import('./index');
});

afterAll(() => {
	database?.collectionSqlite.close();
	rmSync(fixtureDir, { recursive: true, force: true });
});

describe('collection.db', () => {
	it('migrates supported tables and enforces operational deck cascades', async () => {
		const now = Date.now();
		const [deck] = await database.db
			.insert(decks)
			.values({ name: 'Fixture deck', sourceMode: 'local', createdAt: now, updatedAt: now })
			.returning({ id: decks.id });
		const [card] = await database.db
			.insert(deckCards)
			.values({ deckId: deck.id, cardName: 'Island', quantity: 1, board: 'main' })
			.returning({ id: deckCards.id });
		await database.db.insert(cardAssignments).values({
			deckId: deck.id,
			deckCardId: card.id,
			cardName: 'Island',
			status: 'proxied'
		});

		expect(await database.db.select().from(cardAssignments)).toHaveLength(1);
		await database.db.delete(decks).where(eq(decks.id, deck.id));
		expect(await database.db.select().from(deckCards)).toHaveLength(0);
		expect(await database.db.select().from(cardAssignments)).toHaveLength(0);
	});

	it('rolls back synchronous SQLite transactions on failure', () => {
		expect(() =>
			database.db.transaction((tx) => {
				tx.insert(decks)
					.values({
						name: 'Must roll back',
						sourceMode: 'local',
						createdAt: Date.now(),
						updatedAt: Date.now()
					})
					.run();
				throw new Error('fixture failure');
			})
		).toThrow('fixture failure');

		expect(database.db.select().from(decks).all()).toHaveLength(0);
	});
});
