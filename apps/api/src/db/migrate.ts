import { config } from '../config.js';
import { openDatabase, runMigrations } from './client.js';

const { db, sqlite } = openDatabase(config.databaseUrl);
runMigrations(db);
sqlite.close();
console.log(`Migrations applied to ${config.databaseUrl}`);
