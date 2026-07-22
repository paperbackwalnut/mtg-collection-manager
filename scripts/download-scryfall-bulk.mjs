#!/usr/bin/env node
/**
 * Downloads Scryfall's "Default Cards" bulk data file and saves it as
 * scryfall-bulk.json in the project root.
 *
 * The app auto-detects this file on collection import, skipping all API
 * calls and rate limiting. ~500 MB download, takes ~1 min on a typical connection.
 *
 * Usage:  npm run scryfall:download
 */

import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT = resolve(ROOT, 'scryfall-bulk.json');

const HEADERS = {
	'User-Agent': 'MTGCollectionManager/1.0 (local application)',
	Accept: 'application/json'
};

console.log('Fetching Scryfall bulk data manifest…');
const manifestRes = await fetch('https://api.scryfall.com/bulk-data', { headers: HEADERS });
if (!manifestRes.ok) throw new Error(`Manifest fetch failed: ${manifestRes.status}`);

const manifest = await manifestRes.json();
const entry = manifest.data?.find((d) => d.type === 'default_cards');
if (!entry) throw new Error('Could not find default_cards entry in bulk data manifest');

const sizeMB = Math.round(entry.size / 1024 / 1024);
console.log(`Downloading Default Cards (~${sizeMB} MB, updated ${entry.updated_at})…`);
console.log(`Source: ${entry.download_uri}`);
console.log(`Output: ${OUT}`);
console.log('This will take about a minute on a typical connection…');

const dataRes = await fetch(entry.download_uri, { headers: HEADERS });
if (!dataRes.ok) throw new Error(`Download failed: ${dataRes.status}`);
if (!dataRes.body) throw new Error('Response has no body');

// Stream to disk — never loads the full file into memory
await pipeline(Readable.fromWeb(dataRes.body), createWriteStream(OUT));

const { size } = await import('node:fs').then(({ statSync }) => statSync(OUT));
console.log(`\n✓ Done! Saved ${Math.round(size / 1024 / 1024)} MB to scryfall-bulk.json`);
console.log('The app will use this file automatically on the next collection import.');
