import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import Database from 'better-sqlite3';

const root = process.cwd();
loadLocalEnv();

const dbPath = path.resolve(root, process.env.SCRYFALL_DB_PATH ?? 'scryfall.db');
const bulkPath = path.join(root, 'scryfall-bulk.json');
const scryfallMaxAgeDays = positiveNumber(process.env.SCRYFALL_MAX_AGE_DAYS, 7);
const tagMaxAgeDays = positiveNumber(process.env.ORACLE_TAG_MAX_AGE_DAYS, 30);
const prompting = process.env.METADATA_PROMPT !== '0' && Boolean(process.stdin.isTTY);
const prompt = prompting ? createInterface({ input: process.stdin, output: process.stdout }) : null;

try {
	let status = inspectMetadata();
	const scryfallReason = refreshReason(status.cards, scryfallMaxAgeDays, 'Scryfall card metadata');
	if (scryfallReason) {
		console.log(`\n${scryfallReason}`);
		if (await confirm('Download and rebuild it now? This downloads roughly 500 MB.', true)) {
			try {
				runNodeScript('scripts/download-scryfall-bulk.mjs');
				runNodeScript('scripts/seed-scryfall.mjs');
				rmSync(bulkPath, { force: true });
				console.log('Scryfall card metadata is ready.');
			} catch (error) {
				console.warn(`Scryfall setup did not complete: ${message(error)}`);
				console.warn('The app will still start. You can retry from Scryfall Cache.');
			}
		} else {
			console.log('Skipping Scryfall download. You can set it up later from the dashboard.');
		}
	}

	status = inspectMetadata();
	if (status.cards.count > 0) {
		const tagReason = refreshReason(status.tags, tagMaxAgeDays, 'Optional Oracle tags');
		if (tagReason) {
			console.log(`\n${tagReason}`);
			console.log('Oracle tags use an undocumented, best-effort Scryfall endpoint.');
			if (await confirm('Download or refresh Oracle tags now?', false)) {
				try {
					runTsxScript('scripts/fetch-scryfall-oracle-tags.ts');
				} catch (error) {
					console.warn(`Oracle-tag refresh did not complete: ${message(error)}`);
					console.warn('The app will continue without updated tags.');
				}
			} else {
				console.log('Skipping optional Oracle tags.');
			}
		}
	}
} finally {
	prompt?.close();
}

function inspectMetadata() {
	if (!existsSync(dbPath)) {
		return { cards: { count: 0, updatedAt: null }, tags: { count: 0, updatedAt: null } };
	}

	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const tables = new Set(
			/** @type {{ name: string }[]} */ (
				db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
			).map((row) => row.name)
		);
		const cards = tables.has('scryfall_cache')
			? /** @type {{ count: number; updatedAt: number | null }} */ (
					db
						.prepare('SELECT COUNT(*) AS count, MAX(last_updated) AS updatedAt FROM scryfall_cache')
						.get()
				)
			: { count: 0, updatedAt: null };
		const tags = tables.has('scryfall_tag_metadata')
			? /** @type {{ count: number; updatedAt: number | null } | undefined} */ (
					db
						.prepare(
							"SELECT tag_count AS count, fetched_at AS updatedAt FROM scryfall_tag_metadata WHERE kind = 'oracle'"
						)
						.get() ?? { count: 0, updatedAt: null }
				)
			: { count: 0, updatedAt: null };
		return { cards, tags };
	} finally {
		db.close();
	}
}

function refreshReason(metadata, maxAgeDays, label) {
	if (metadata.count === 0 || !metadata.updatedAt) return `${label} is not installed.`;
	const ageDays = Math.floor((Date.now() - metadata.updatedAt) / 86_400_000);
	return ageDays > maxAgeDays
		? `${label} is ${ageDays} days old (refresh reminder: ${maxAgeDays} days).`
		: null;
}

async function confirm(question, defaultYes) {
	if (!prompt) {
		console.log('Metadata prompts are unavailable in this non-interactive launch; skipping.');
		return false;
	}
	const hint = defaultYes ? '[Y/n]' : '[y/N]';
	const answer = (await prompt.question(`${question} ${hint} `)).trim().toLowerCase();
	if (!answer) return defaultYes;
	return answer === 'y' || answer === 'yes';
}

function runNodeScript(relativePath) {
	execFileSync(process.execPath, [path.join(root, relativePath)], {
		cwd: root,
		env: process.env,
		stdio: 'inherit'
	});
}

function runTsxScript(relativePath) {
	execFileSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), relativePath], {
		cwd: root,
		env: process.env,
		stdio: 'inherit'
	});
}

function loadLocalEnv() {
	const envPath = path.join(root, '.env');
	if (!existsSync(envPath)) return;
	for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const separator = line.indexOf('=');
		if (separator < 1) continue;
		const key = line.slice(0, separator).trim();
		const value = line
			.slice(separator + 1)
			.trim()
			.replace(/^(['"])(.*)\1$/, '$2');
		if (!(key in process.env)) process.env[key] = value;
	}
}

function positiveNumber(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function message(error) {
	return error instanceof Error ? error.message : String(error);
}
