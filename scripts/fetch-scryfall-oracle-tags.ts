#!/usr/bin/env tsx
/**
 * scripts/fetch-scryfall-oracle-tags.ts
 *
 * CLI wrapper — fetches Scryfall oracle tags and stores them in scryfall.db.
 *
 * Usage:  pnpm scryfall:tags
 *
 * Uses If-None-Match so repeated runs are cheap when tags haven't changed.
 * The underlying service validates the full response before replacing data.
 */

import { refreshOracleTags, getTagMetadata } from '../src/lib/server/scryfall-oracle-tags.js';

const existing = getTagMetadata();
if (existing) {
	const age = Math.round((Date.now() - existing.fetched_at) / 3600_000);
	console.log(
		`Existing tags: ${existing.tag_count} tags, ${existing.relation_count} card relations (${age}h ago)`
	);
	if (existing.etag) console.log(`ETag: ${existing.etag}`);
} else {
	console.log('No existing tag data — performing first import.');
}

console.log('\nFetching oracle tags from Scryfall…');
const result = await refreshOracleTags();

switch (result.status) {
	case 'ok':
		console.log(`✓ Done: ${result.tagCount} tags, ${result.relationCount} card relations`);
		if (result.etag) console.log(`  ETag stored: ${result.etag}`);
		break;
	case 'not_modified':
		console.log('✓ Tags are up to date (304 Not Modified — no changes)');
		break;
	case 'already_running':
		console.error('✗ Another refresh is already in progress');
		process.exit(1);
		break;
	case 'error':
		console.error('✗ Refresh failed:', result.error);
		process.exit(1);
		break;
}
