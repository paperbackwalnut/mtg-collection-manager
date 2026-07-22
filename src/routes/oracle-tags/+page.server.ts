import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { collection } from '$lib/server/db/schema';
import { isNotNull } from 'drizzle-orm';
import { getOracleTagDirectory } from '$lib/server/oracle-tag-directory';

const PAGE_SIZE = 100;

export const load: PageServerLoad = async ({ url }) => {
	const query = url.searchParams.get('q')?.trim() ?? '';
	const inCollectionOnly = url.searchParams.get('owned') === '1';
	const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const printingRows = await db
		.selectDistinct({ scryfallId: collection.scryfallId })
		.from(collection)
		.where(isNotNull(collection.scryfallId));
	return {
		query,
		inCollectionOnly,
		directory: getOracleTagDirectory({
			query,
			inCollectionOnly,
			page,
			pageSize: PAGE_SIZE,
			collectionScryfallIds: printingRows
				.map((row) => row.scryfallId)
				.filter((id): id is string => id !== null)
		})
	};
};
