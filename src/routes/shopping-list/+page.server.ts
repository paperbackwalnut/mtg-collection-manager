import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/index';
import { shoppingList } from '$lib/server/db/schema';

export const load: PageServerLoad = async () => {
	const items = await db.select().from(shoppingList).orderBy(shoppingList.addedAt);
	return { items };
};
