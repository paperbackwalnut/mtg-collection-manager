import type { Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db/index';
import { collection } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { getBySetColl } from '$lib/server/db/scryfall-sqlite';
import { invalidateCollectionSearchCandidates } from '$lib/server/collection-search-candidates';
import { isWritableCardLocation } from '$lib/types';

export const actions: Actions = {
	add: async ({ request }) => {
		const data = await request.formData();
		const name = ((data.get('name') as string) ?? '').trim();
		const setCode = ((data.get('setCode') as string) ?? '').trim().toLowerCase();
		const collectorNumber = ((data.get('collectorNumber') as string) ?? '').trim();
		const quantity = Math.max(1, parseInt((data.get('quantity') as string) ?? '1') || 1);
		const condition = (data.get('condition') as string) ?? 'NM';
		const language = (data.get('language') as string) ?? 'English';
		const foil = data.get('foil') === 'true';
		const locationOverride = ((data.get('locationOverride') as string) ?? '') || null;
		const tagsRaw = ((data.get('tags') as string) ?? '').trim();
		const tags = tagsRaw
			? JSON.stringify(
					tagsRaw
						.split(',')
						.map((t) => t.trim())
						.filter(Boolean)
				)
			: null;

		if (!name) return fail(400, { error: 'Card name is required.' });
		if (!setCode || !collectorNumber)
			return fail(400, { error: 'Set code and collector number are required.' });
		if (locationOverride && !isWritableCardLocation(locationOverride)) {
			return fail(400, { error: 'Invalid location.' });
		}

		// Look up scryfallId from local SQLite
		const sc = getBySetColl(setCode, collectorNumber);
		const scryfallId = sc?.id ?? null;
		const oracleId = sc?.oracle_id ?? null;

		// Check for an existing identical entry — merge quantity rather than duplicate
		const [existing] = await db
			.select({ id: collection.id, quantity: collection.quantity })
			.from(collection)
			.where(
				and(
					eq(collection.name, name),
					eq(collection.setCode, setCode),
					eq(collection.collectorNumber, collectorNumber),
					eq(collection.foil, foil)
				)
			)
			.limit(1);

		if (existing) {
			await db
				.update(collection)
				.set({
					quantity: existing.quantity + quantity,
					...(locationOverride ? { locationOverride } : {}),
					...(sc
						? {
								scryfallId: sc.id,
								...(sc.oracle_id ? { oracleId: sc.oracle_id } : {})
							}
						: {})
				})
				.where(eq(collection.id, existing.id));
			if (sc) invalidateCollectionSearchCandidates();
			return { success: true, merged: true, name, quantity: existing.quantity + quantity };
		}

		await db.insert(collection).values({
			scryfallId,
			oracleId,
			name,
			setCode,
			collectorNumber,
			condition,
			language,
			foil,
			quantity,
			locationOverride,
			tags
		});
		invalidateCollectionSearchCandidates();

		return { success: true, merged: false, name, quantity };
	}
};
