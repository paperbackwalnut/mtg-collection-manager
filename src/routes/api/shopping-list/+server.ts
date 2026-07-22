import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/index';
import { shoppingList } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';

/** GET /api/shopping-list — return all items ordered by addedAt desc */
export const GET: RequestHandler = async () => {
	const items = await db.select().from(shoppingList).orderBy(shoppingList.addedAt);
	return json(items);
};

/** POST /api/shopping-list — upsert one item (add or increase qty if exists) */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as {
		cardName: string;
		quantity?: number;
		source?: string;
		notes?: string;
	};
	const { cardName, quantity = 1, source, notes } = body;
	if (!cardName?.trim()) return json({ error: 'cardName required' }, { status: 400 });

	const now = Date.now();

	// ON CONFLICT(card_name) DO UPDATE: add incoming qty to existing qty
	await db
		.insert(shoppingList)
		.values({
			cardName: cardName.trim(),
			quantity,
			notes: notes ?? null,
			source: source ?? null,
			addedAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: shoppingList.cardName,
			set: {
				quantity: sql`${shoppingList.quantity} + excluded.quantity`,
				updatedAt: now
			}
		});

	const [item] = await db
		.select()
		.from(shoppingList)
		.where(eq(shoppingList.cardName, cardName.trim()))
		.limit(1);
	return json(item, { status: 201 });
};

/** PATCH /api/shopping-list — update qty or notes for one item */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { cardName: string; quantity?: number; notes?: string };
	const { cardName, quantity, notes } = body;
	if (!cardName?.trim()) return json({ error: 'cardName required' }, { status: 400 });

	const patch: Record<string, unknown> = { updatedAt: Date.now() };
	if (quantity !== undefined) patch.quantity = Math.max(1, quantity);
	if (notes !== undefined) patch.notes = notes;

	await db.update(shoppingList).set(patch).where(eq(shoppingList.cardName, cardName.trim()));
	const [item] = await db
		.select()
		.from(shoppingList)
		.where(eq(shoppingList.cardName, cardName.trim()))
		.limit(1);
	return json(item);
};

/** DELETE /api/shopping-list — remove one item (body: {cardName}) or clear all (body: {all:true}) */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { cardName?: string; all?: boolean };
	if (body.all) {
		await db.delete(shoppingList);
	} else if (body.cardName?.trim()) {
		await db.delete(shoppingList).where(eq(shoppingList.cardName, body.cardName.trim()));
	} else {
		return json({ error: 'cardName or all required' }, { status: 400 });
	}
	return json({ ok: true });
};
