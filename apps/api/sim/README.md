# Market-entry simulation

A re-runnable, six-month simulation of Merge being adopted by a network of care providers. It boots the
real API in-process with a controllable clock and drives it through HTTP exactly as the people involved
would: an agency owner, HR and rota managers at twenty providers of different sizes, compliance officers,
finance clerks, and care workers on their phones. Every action is attributed to a human task, so the
number of calls a task needs is a direct measure of how laborious it is, and every point where a task is
impossible, clumsy or silently wrong is recorded as a gap with evidence.

```bash
npm run sim -w @merge/api                 # 26 weeks, seed 42 (about 15–25 minutes)
npm run sim -w @merge/api -- --weeks 4    # quick run
npm run sim -w @merge/api -- --seed 7     # a different random history
```

Outputs:

| File | What |
| --- | --- |
| `docs/SIMULATION-REPORT.md` | Month-by-month metrics, calls-per-task table, refusal reasons, notification volume, the gap register and the decisions it raises. |
| `apps/api/sim-output/result.json` | The raw numbers behind the report (ignored by git). |
| `apps/api/data/sim.db` | The database at the end of the run. Browse the six-month state in the web app with `DATABASE_URL=./data/sim.db npm run dev -w @merge/api` and `npm run dev:web`; every manager login is `admin@<organisation-name>.example` / `Simulation-Pass-1`. |

## What happens in the run

- **Week 1:** the agency bootstraps with a bank of 25; Northern Care Group (400 staff, 8 sites), Riverside Living (45) and Oakwood Care Homes (90) join and onboard every worker one record and six to eight documents at a time.
- **Weeks 3–19:** seventeen more providers join, including Trafford Care Partnership (250 staff, 5 sites) with a standing surplus.
- **Every week:** each provider's staffing balance drifts with winter pressure (peaking mid-January) and random shocks; short providers queue shifts with realistic lead times, spare providers raise surplus flags, suppliers and self-service workers check the board at their own hours, hosts confirm first-come-first-served, workers clock in and out, hosts approve or dispute timesheets, compliance officers renew expiring documents (with a lag), and statements go out on the first of the month.
- **Scripted events:** week 9 a worker changes employer; week 14 a host blocks its least reliable supplier; week 15 the agency hires 20 more bank workers; weeks 17–20 the agency bank is released first; week 18 a CQC-style request for who worked at a site; week 21 a non-paying host is suspended; week 22 a worker makes a data-subject request; week 24 a provider leaves.
- **At the end:** reporting, pagination, clock-change and notification-volume probes, plus checks on the data itself (for example worker-weeks over 48 hours once contracted hours are counted).

## Extending it

- `scenario.ts` holds the world model and weekly behaviours; `events.ts` the scripted probes; `run.ts` the provider roster and the main loop; `report.ts` the Markdown renderer.
- To test a product change, make it, re-run with the same seed, and diff `docs/SIMULATION-REPORT.md`: calls per task, fill rate, time to fill and the gap register will move.
- Add a probe by writing a function that attempts the task through the API and calls `gaps.record(...)` with what happened. Use a stable `id` so repeat runs can be compared.
- When a probe finds the feature working, record the same `id` with `status: 'fixed'` and evidence that carries the numbers; the report lists those under "Verified fixed in this run" and leaves them out of the open register. A fixed gap re-recorded later refreshes its evidence (the end-of-run figures win); a failure seen once keeps the gap open.
