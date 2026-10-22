/**
 * Serve the end state of a simulation with the clock frozen at the sim's final day, so the API and
 * web app show that moment rather than today.
 *
 *   npm run sim:serve -w @merge/api            # apps/api/data/sim.db at 2027-05-03T08:00Z on port 4000
 *   SIM_NOW=2027-03-01T09:00:00Z PORT=4100 npm run sim:serve -w @merge/api
 */
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';

const dbPath = process.env.DATABASE_URL ?? './data/sim.db';
const frozen = new Date(process.env.SIM_NOW ?? '2027-05-03T08:00:00Z');
const port = Number(process.env.PORT ?? 4000);
const { db } = openDatabase(dbPath);
runMigrations(db);
const { app } = createApp({ db, now: () => frozen, channels: [] });
app.listen(port, () => console.log(`Simulation state from ${dbPath} served on http://localhost:${port} with the clock frozen at ${frozen.toISOString()}`));
