import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

const here = dirname(fileURLToPath(import.meta.url));
// Works both from src/ (tsx) and from dist/ (bundled): the migrations folder sits at the package root.
const migrationsFolder = resolve(here, basename(here) === 'dist' ? '../drizzle' : '../../drizzle');

export function openDatabase(url: string): { db: Db; sqlite: Database.Database } {
  if (url !== ':memory:') mkdirSync(dirname(resolve(url)), { recursive: true });
  const sqlite = new Database(url);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
}

export { schema };
