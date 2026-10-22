# Architecture

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript everywhere (Node 24 LTS) | One domain model shared by API, rules engine and UI. |
| Rules engine | `packages/shared` – pure functions, no I/O | Dispatch and eligibility are the product; keeping them pure makes them unit-testable and lets the UI explain decisions with the same code. |
| API | Express 4, Zod validation, JWT auth | Small, well understood, easy to host anywhere. |
| Database | Drizzle ORM on SQLite (better-sqlite3) | Zero-setup for development and demos; the schema uses plain column types so moving to Postgres is a driver swap plus regenerated migrations. |
| Web | React 18, Vite, Tailwind v4, React Router, TanStack Query | Fast to build, easy to deploy as static files. |
| Tests | Vitest (+ supertest for the API) | The API tests run against an in-memory database with an injectable clock so dispatch windows can be fast-forwarded. |

## Modules

```
packages/shared/src
  enums.ts              roles, statuses, role cover matrix, labels
  dispatch/engine.ts    planDispatch(): shift + organisations + settings → release plan
  rules/eligibility.ts  evaluateEligibility(): shift + worker + context → blockers/warnings
  rules/compliance.ts   required documents per role, document status as of a date
  rules/workingTime.ts  rest gaps, weekly hours, overlaps
  money.ts, time.ts, geo.ts

apps/api/src
  db/schema.ts          Drizzle schema (all tables)
  db/client.ts          open database, run migrations
  lib/                  auth (JWT, role guards), validation, errors, ids, audit, notifications
  services/
    dispatch.ts         load network state → build/persist plan, open tiers, notify
    eligibility.ts      assemble DB context → shared evaluator
    capacity.ts         flags lifecycle and hour accounting
    shifts.ts           publish, cancel, time-based progression
    assignments.ts      request / offer / confirm / decline / withdraw / cancel / no-show
    timesheets.ts       clock in/out, submit, approve, dispute
    invoices.ts         statements from approved timesheets
    scheduler.ts        background tick
  routes/               thin HTTP handlers: validate → authorise → call service → respond
  app.ts                express app factory (used by server and tests)
  server.ts             boot: migrate, start scheduler, listen
```

Handlers never contain business rules; services never read HTTP. Every service takes `now: Date` explicitly so behaviour is deterministic and testable.

## Request flow: publishing a shift

1. `POST /shifts { publish: true }` → `routes/shifts.ts` validates and checks the caller manages the host organisation.
2. `services/shifts.publishShift` → `services/dispatch.buildPlan` loads every organisation, their active surplus flags and the relationships to the host, then calls the pure `planDispatch`.
3. The plan is persisted as `shift_access` rows (one per organisation: tier, opens-at, rank, reason).
4. `notifyDueAccess` immediately notifies organisations whose stage is already open; the scheduler notifies the rest as their stage opens.

## Request flow: putting a worker forward

1. `POST /shifts/:id/requests { workerId }`.
2. `services/eligibility.evaluateWorkerForShift` gathers documents, booked shifts, unavailability and the organisation's `shift_access` row and runs `evaluateEligibility`.
3. Blockers → `422` with the list of reasons (the UI shows them). Otherwise an assignment is created as `REQUESTED` (or `CONFIRMED` if the host enabled auto-confirm).
4. Confirmation increments `filledCount`, consumes hours on the matched surplus flag, creates a draft timesheet, and auto-declines any other pending requests once the shift is full.

## Scheduler

`services/scheduler.tick` runs every `SCHEDULER_INTERVAL_SECONDS` (default 60) and on boot. It is idempotent:

- opens dispatch stages whose time has come and notifies those organisations;
- expires capacity flags past their end date;
- moves shifts `OPEN/FILLED → IN_PROGRESS → COMPLETED`, or `OPEN → EXPIRED` when nobody was confirmed (closing pending requests);
- warns hosts once about shifts starting within 24 h with places still open;
- alerts employers about documents expiring within 30 days (once per document per week).

`POST /admin/scheduler/tick` runs it on demand.

## Security model

- JWT bearer tokens; passwords hashed with bcrypt.
- Four roles. Platform admins (agency staff) may act on any organisation; everyone else only on their own. Workers only on themselves, and a worker login stops working the moment the worker record is deactivated.
- New organisations register as PENDING and are approved by the platform admin before they can publish or receive shifts; site access notes (door codes, who to report to) are released only to an organisation with a confirmed booking on that shift.
- Data minimisation across organisations: hosts see worker name, role, skills and ratings, never pay rates or notes; suppliers see site address and access notes only for shifts released to them (site lists are never readable cross-organisation); capacity flags are aggregated for providers and itemised only for the platform admin; workers with a login see only their own bookings and timesheets, never colleagues'.
- Working-time weeks run Monday 00:00 to Sunday 24:00 in Europe/London, so the 48 h cap behaves correctly across the BST/GMT changes.
- Every state change writes an `audit_log` row with actor, action, entity and payload.

## Deployment notes

- `npm run build` bundles the API (esbuild, native `better-sqlite3` kept external) and the web app (static `dist/`).
- The provided `Dockerfile`/`docker-compose.yml` run the API with a persistent SQLite volume and serve the web build with nginx proxying `/api`.
- For production scale: switch Drizzle to Postgres, move the scheduler into a separate worker process, add a queue-backed notification channel (email/SMS/push) implementing `NotificationChannel`, put document files in object storage, and run behind TLS with a real `JWT_SECRET`.
