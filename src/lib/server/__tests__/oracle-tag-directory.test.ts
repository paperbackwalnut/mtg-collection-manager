import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from '../db/scryfall-sqlite';
import {
	getOracleTagDirectory,
	getOracleTagDirectoryState,
	searchOracleTagLabels
} from '../oracle-tag-directory';

const tempPaths: string[] = [];

function tempDbPath(): string {
	const dbPath = path.join(
		os.tmpdir(),
		`oracle-directory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
	);
	tempPaths.push(dbPath);
	return dbPath;
}

function seedDirectoryDb(dbPath: string, withTags = true): void {
	const d = openDb(dbPath);
	d.prepare(
		`
		INSERT INTO scryfall_cache
			(id, name, set_code, collector_number, last_updated, oracle_id)
		VALUES (?, ?, 'tst', ?, 1000, ?)
	`
	).run('print-a', 'Alpha Card', '1', 'oracle-a');
	d.prepare(
		`
		INSERT INTO scryfall_cache
			(id, name, set_code, collector_number, last_updated, oracle_id)
		VALUES (?, ?, 'tst', ?, 1000, ?)
	`
	).run('print-b', 'Beta Card', '2', 'oracle-b');
	d.prepare(
		`
		INSERT INTO scryfall_cache
			(id, name, set_code, collector_number, last_updated, oracle_id)
		VALUES (?, ?, 'tst', ?, 1000, ?)
	`
	).run('print-c', 'Gamma Card', '3', 'oracle-c');

	if (withTags) {
		d.exec(`
			CREATE TABLE scryfall_oracle_tags (
				id TEXT PRIMARY KEY,
				label TEXT NOT NULL COLLATE NOCASE,
				description TEXT
			);
			CREATE TABLE scryfall_oracle_tag_cards (
				tag_id TEXT NOT NULL,
				oracle_id TEXT NOT NULL,
				PRIMARY KEY (tag_id, oracle_id)
			);
			CREATE INDEX idx_sotc_tag ON scryfall_oracle_tag_cards(tag_id);
			CREATE INDEX idx_sotc_oracle ON scryfall_oracle_tag_cards(oracle_id);
			INSERT INTO scryfall_oracle_tags (id, label, description) VALUES
				('ramp-a', 'Ramp', 'Accelerates mana production.'),
				('ramp-b', 'ramp', 'Mana acceleration.'),
				('draw', 'Card Draw', 'Adds cards to hand.'),
				('burn', 'Burn', 'Deals direct damage.');
			INSERT INTO scryfall_oracle_tag_cards (tag_id, oracle_id) VALUES
				('ramp-a', 'oracle-a'),
				('ramp-b', 'oracle-b'),
				('draw', 'oracle-b'),
				('burn', 'oracle-c');
		`);
	}
	d.close();
}

afterEach(() => {
	for (const dbPath of tempPaths.splice(0)) {
		for (const suffix of ['', '-wal', '-shm']) {
			try {
				fs.unlinkSync(dbPath + suffix);
			} catch {
				/* ignore */
			}
		}
	}
});

describe('getOracleTagDirectory', () => {
	it('distinguishes a missing database without creating it', () => {
		const dbPath = tempDbPath();
		expect(getOracleTagDirectoryState(dbPath)).toBe('missing_db');
		expect(getOracleTagDirectory({ dbPath }).state).toBe('missing_db');
		expect(fs.existsSync(dbPath)).toBe(false);
	});

	it('distinguishes an existing cache with no imported tag tables', () => {
		const dbPath = tempDbPath();
		seedDirectoryDb(dbPath, false);
		expect(getOracleTagDirectoryState(dbPath)).toBe('tags_missing');
		expect(getOracleTagDirectory({ dbPath }).state).toBe('tags_missing');
	});

	it('maps collection printing IDs to Oracle IDs and collapses case-duplicate labels', () => {
		const dbPath = tempDbPath();
		seedDirectoryDb(dbPath);
		const result = getOracleTagDirectory({
			dbPath,
			collectionScryfallIds: ['print-a', 'print-b']
		});

		expect(result.state).toBe('ready');
		expect(result.total).toBe(3);
		expect(result.entries.filter((entry) => entry.label.toLowerCase() === 'ramp')).toHaveLength(1);
		expect(
			result.entries.find((entry) => entry.label.toLowerCase() === 'ramp')?.collectionCount
		).toBe(2);
		expect(result.entries.find((entry) => entry.label === 'Burn')?.collectionCount).toBe(0);
	});

	it('filters to tags represented in the collection', () => {
		const dbPath = tempDbPath();
		seedDirectoryDb(dbPath);
		const result = getOracleTagDirectory({
			dbPath,
			collectionScryfallIds: ['print-b'],
			inCollectionOnly: true
		});

		expect(result.entries.map((entry) => entry.label.toLowerCase())).toEqual(['card draw', 'ramp']);
		expect(result.entries.every((entry) => entry.collectionCount > 0)).toBe(true);
	});

	it('searches labels case-insensitively', () => {
		const dbPath = tempDbPath();
		seedDirectoryDb(dbPath);
		const result = getOracleTagDirectory({ dbPath, query: 'DRAW' });

		expect(result.total).toBe(1);
		expect(result.entries[0].label).toBe('Card Draw');
	});

	it('paginates filtered results and clamps an out-of-range page', () => {
		const dbPath = tempDbPath();
		seedDirectoryDb(dbPath);

		const secondPage = getOracleTagDirectory({ dbPath, page: 2, pageSize: 1 });
		expect(secondPage.page).toBe(2);
		expect(secondPage.entries).toHaveLength(1);

		const clamped = getOracleTagDirectory({ dbPath, page: 99, pageSize: 2 });
		expect(clamped.page).toBe(2);
		expect(clamped.entries).toHaveLength(1);
	});

	it('searches autocomplete labels locally and collapses case duplicates', () => {
		const dbPath = tempDbPath();
		seedDirectoryDb(dbPath);
		const result = searchOracleTagLabels('ra', 8, dbPath);

		expect(result.state).toBe('ready');
		expect(result.labels[0].toLowerCase()).toBe('ramp');
		expect(result.labels.filter((label) => label.toLowerCase() === 'ramp')).toHaveLength(1);
	});
});
