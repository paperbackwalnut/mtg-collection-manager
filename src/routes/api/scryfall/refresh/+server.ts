import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { refreshPricesFromBulkData } from '$lib/server/scryfall';

export const POST: RequestHandler = async () => {
	try {
		const updated = await refreshPricesFromBulkData();
		return json({ updated });
	} catch (e) {
		return json({ error: String(e) }, { status: 500 });
	}
};
