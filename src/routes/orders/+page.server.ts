import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db/index';
import { orders, collection } from '$lib/server/db/schema';
import { normalizeOrderSource } from '$lib/server/order-sources';
import { and, eq, desc } from 'drizzle-orm';

export const load: PageServerLoad = async () => {
	const allOrders = await db.select().from(orders).orderBy(desc(orders.orderedAt));
	return { orders: allOrders };
};

export const actions: Actions = {
	add: async ({ request }) => {
		const data = await request.formData();
		const cardName = ((data.get('cardName') as string) ?? '').trim();
		const setCode = ((data.get('setCode') as string) ?? '').trim() || null;
		const collectorNumber = ((data.get('collectorNumber') as string) ?? '').trim() || null;
		const quantity = parseInt((data.get('quantity') as string) ?? '1') || 1;
		const source = normalizeOrderSource(data.get('source'));
		const notes = ((data.get('notes') as string) ?? '').trim() || null;
		if (!cardName) return fail(400, { error: 'Card name is required.' });
		if (!Number.isInteger(quantity) || quantity < 1) {
			return fail(400, { error: 'Quantity must be at least 1.' });
		}
		await db.insert(orders).values({
			cardName,
			setCode,
			collectorNumber,
			quantity,
			source,
			notes,
			status: 'ordered',
			orderedAt: Date.now()
		});
		return { success: true };
	},

	markArrived: async ({ request }) => {
		const data = await request.formData();
		const id = parseInt(data.get('id') as string);
		const addToCollection = data.get('addToCollection') === 'true';
		const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
		if (!order) return fail(404, { error: 'Order not found.' });
		const arrivedAt = Date.now();
		const [updated] = await db
			.update(orders)
			.set({ status: 'arrived', arrivedAt })
			.where(and(eq(orders.id, id), eq(orders.status, 'ordered')))
			.returning({ id: orders.id });
		if (!updated) return fail(409, { error: 'Order has already been resolved.' });
		if (addToCollection) {
			// Match by name + set + collector number first; fall back to name only.
			// This prevents incrementing the wrong printing when you own the same
			// card in multiple sets.
			const exactMatch =
				order.setCode && order.collectorNumber
					? await db
							.select()
							.from(collection)
							.where(
								and(
									eq(collection.name, order.cardName),
									eq(collection.setCode, order.setCode),
									eq(collection.collectorNumber, order.collectorNumber)
								)
							)
							.limit(1)
					: [];

			if (exactMatch.length > 0) {
				await db
					.update(collection)
					.set({ quantity: exactMatch[0].quantity + order.quantity })
					.where(eq(collection.id, exactMatch[0].id));
			} else {
				// No exact printing match — try name-only fallback
				const nameMatch = await db
					.select()
					.from(collection)
					.where(eq(collection.name, order.cardName))
					.limit(1);
				if (nameMatch.length > 0) {
					await db
						.update(collection)
						.set({ quantity: nameMatch[0].quantity + order.quantity })
						.where(eq(collection.id, nameMatch[0].id));
				}
				// If no collection entry exists at all, we don't auto-create one
				// (user should import the card via CSV after it arrives)
			}
		}
		return { success: true };
	},

	cancel: async ({ request }) => {
		const data = await request.formData();
		const id = parseInt(data.get('id') as string);
		await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, id));
		return { success: true };
	},

	delete: async ({ request }) => {
		const data = await request.formData();
		const id = parseInt(data.get('id') as string);
		await db.delete(orders).where(eq(orders.id, id));
		return { success: true };
	}
};
