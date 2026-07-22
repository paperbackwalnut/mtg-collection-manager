import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';
import * as schema from './schema';

export const COLLECTION_DB_PATH =
	process.env.COLLECTION_DB_PATH || path.join(process.cwd(), 'collection.db');

const client = new Database(COLLECTION_DB_PATH);
client.pragma('foreign_keys = ON');
client.pragma('journal_mode = WAL');
client.pragma('busy_timeout = 5000');

export const db = drizzle(client, { schema });
export const collectionSqlite = client;

try {
	migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
} catch (cause) {
	client.close();
	throw new Error(
		`Could not initialize the local collection database at ${COLLECTION_DB_PATH}. ` +
			'Check that the directory is writable and the drizzle migration folder is present.',
		{ cause }
	);
}
