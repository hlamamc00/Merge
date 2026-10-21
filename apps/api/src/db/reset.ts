import { rmSync } from 'node:fs';
import { config } from '../config.js';

if (config.databaseUrl === ':memory:') {
  console.log('In-memory database: nothing to reset');
} else {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(config.databaseUrl + suffix, { force: true });
  console.log(`Removed ${config.databaseUrl}. Run "npm run db:migrate" then "npm run db:seed".`);
}
