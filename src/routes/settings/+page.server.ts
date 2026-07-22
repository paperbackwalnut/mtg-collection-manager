import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTagMetadata, refreshOracleTags } from '$lib/server/scryfall-oracle-tags';

export const load: PageServerLoad = async () => ({
	oracleTagMetadata: getTagMetadata()
});

export const actions: Actions = {
	refreshOracleTags: async () => {
		const result = await refreshOracleTags();

		if (result.status === 'already_running') {
			return fail(409, {
				oracleTagRefresh: 'already_running',
				oracleTagMessage: 'An Oracle tag refresh is already running.'
			});
		}

		if (result.status === 'error') {
			return fail(502, {
				oracleTagRefresh: 'error',
				oracleTagMessage: result.error ?? 'Oracle tag refresh failed.'
			});
		}

		return {
			oracleTagRefresh: result.status,
			oracleTagMessage:
				result.status === 'not_modified'
					? 'Oracle tags are already current.'
					: `Updated ${result.tagCount?.toLocaleString() ?? 0} tags and ${result.relationCount?.toLocaleString() ?? 0} card relationships.`
		};
	}
};
