import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { getStats, dbFilePath } from '$lib/server/db/scryfall-sqlite';
import { seedScryfallCache } from '$lib/server/scryfall';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const LOCAL_BULK_PATH = path.resolve(process.cwd(), 'scryfall-bulk.json');
const TEMP_BULK_PATH = `${LOCAL_BULK_PATH}.download`;

async function downloadDefaultCards(): Promise<void> {
	const headers = {
		'User-Agent': 'MTGCollectionManager/1.0 (local application)',
		Accept: 'application/json'
	};
	const manifestResponse = await fetch('https://api.scryfall.com/bulk-data', { headers });
	if (!manifestResponse.ok) {
		throw new Error(`Scryfall manifest request failed (${manifestResponse.status})`);
	}
	const manifest = await manifestResponse.json();
	const entry = manifest.data?.find((item: { type?: string }) => item.type === 'default_cards');
	if (!entry?.download_uri) throw new Error('Scryfall did not provide a Default Cards download');

	const downloadResponse = await fetch(entry.download_uri, { headers });
	if (!downloadResponse.ok || !downloadResponse.body) {
		throw new Error(`Scryfall bulk download failed (${downloadResponse.status})`);
	}
	await pipeline(
		Readable.fromWeb(downloadResponse.body as import('node:stream/web').ReadableStream),
		fs.createWriteStream(TEMP_BULK_PATH)
	);
	fs.renameSync(TEMP_BULK_PATH, LOCAL_BULK_PATH);
}

export const load: PageServerLoad = async () => {
	const { total: cacheTotal, lastUpdated } = getStats();

	const localFileExists = fs.existsSync(LOCAL_BULK_PATH);
	let localFileSizeMB: number | null = null;
	if (localFileExists) {
		localFileSizeMB = Math.round(fs.statSync(LOCAL_BULK_PATH).size / 1024 / 1024);
	}

	return {
		cacheTotal,
		lastUpdated: lastUpdated ?? null,
		localFileExists,
		localFileSizeMB,
		localBulkPath: LOCAL_BULK_PATH,
		scryfallDbPath: dbFilePath()
	};
};

export const actions: Actions = {
	refreshFromScryfall: async () => {
		const current = getStats();
		if (current.total > 0) {
			return { refreshSuccess: true, inserted: 0, skipped: current.total, total: current.total };
		}
		try {
			process.stdout.write('[Scryfall setup] Downloading Default Cards…\n');
			await downloadDefaultCards();
			process.stdout.write('[Scryfall setup] Building local cache…\n');
			const stream = fs.createReadStream(LOCAL_BULK_PATH);
			const { inserted, skipped, total } = await seedScryfallCache(stream);
			fs.rmSync(LOCAL_BULK_PATH, { force: true });
			return { refreshSuccess: true, inserted, skipped, total };
		} catch (error) {
			fs.rmSync(TEMP_BULK_PATH, { force: true });
			console.error('[Scryfall setup] Failed:', error);
			return fail(500, {
				error: `Scryfall setup failed: ${error instanceof Error ? error.message : String(error)}`
			});
		}
	},
	seedFromLocal: async () => {
		process.stdout.write('[Scryfall seed] seedFromLocal action triggered\n');

		if (!fs.existsSync(LOCAL_BULK_PATH)) {
			const msg = `No file found at: ${LOCAL_BULK_PATH}`;
			console.error('[Scryfall seed]', msg);
			return fail(400, { error: msg });
		}

		const sizeMB = Math.round(fs.statSync(LOCAL_BULK_PATH).size / 1024 / 1024);
		process.stdout.write(`[Scryfall seed] Found file: ${LOCAL_BULK_PATH} (${sizeMB} MB)\n`);

		try {
			const stream = fs.createReadStream(LOCAL_BULK_PATH);
			const { inserted, skipped, total } = await seedScryfallCache(stream);
			return { seedSuccess: true, inserted, skipped, total };
		} catch (e) {
			console.error('[Scryfall seed] Fatal error:', e);
			return fail(500, { error: `Seed failed: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
};
