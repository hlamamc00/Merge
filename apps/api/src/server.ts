import { createApp } from './app.js';
import { config } from './config.js';
import { openDatabase, runMigrations } from './db/client.js';
import { startScheduler } from './services/scheduler.js';

const { db } = openDatabase(config.databaseUrl);
runMigrations(db);
const { app, deps } = createApp({ db });
const stop = startScheduler(db, deps.notifier, config.schedulerIntervalSeconds, deps.now, (m) => console.log(m));

const server = app.listen(config.port, () => {
  console.log(`Merge API listening on http://localhost:${config.port} (db: ${config.databaseUrl})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stop();
    server.close(() => process.exit(0));
  });
}
