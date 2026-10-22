# Integration notes from build D (finance and settlement)

Everything below touches files owned by other builds or the parent; apply after those builds finish.

## 1. Scheduler hooks (`src/services/scheduler.ts`, build B)

Both jobs are idempotent and cheap, so they can run on every tick; the finance job only acts once a day per invoice anyway (reminders are keyed on `remindedAt`).

```ts
import { runFinanceJobs } from './settlement.js';
import { autoApproveStaleTimesheets } from './timesheets.js';
import { platformSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// inside tick(db, notifier, now), after the existing jobs:
const settings = db.select().from(platformSettings).where(eq(platformSettings.id, 'default')).get()!;
const finance = runFinanceJobs(db, notifier, settings, now);      // ISSUED→OVERDUE after dueAt; reminders at 7 and 14 days; credit hold at 30; hold released when nothing is overdue
const autoApproved = autoApproveStaleTimesheets(db, notifier, now); // SUBMITTED for 14 days → APPROVED, both sides notified
// add to TickResult if you want them in the response: { ...result, finance, autoApproved: autoApproved.length }
```

`POST /api/v1/finance/jobs/run` (platform admin) runs the same finance job on demand and returns `{ markedOverdue, reminders, holdsApplied, holdsCleared }`; the Agency finance page has a button for it, and the simulation harness can call it after advancing the clock.

## 2. Credit hold on posting (`src/services/shifts.ts` `publishShift`, or `routes/shifts.ts`, build B)

Decision 1: hosts more than 30 days overdue cannot publish new shifts. `organisations.creditHold` is set and cleared by `runFinanceJobs`. Add at the top of `publishShift` (or in the route before calling it):

```ts
import { organisations } from '../db/schema.js';
const host = db.select({ creditHold: organisations.creditHold }).from(organisations).where(eq(organisations.id, shift.hostOrgId)).get();
if (host?.creditHold) throw conflict('Posting is paused: invoices are more than 30 days overdue. Pay them to publish shifts again.', { code: 'CREDIT_HOLD' });
```

The Statements page already shows the host a red banner when `GET /finance/summary` returns `creditHold: true`; the shift form could read the same endpoint to disable the Publish button.

## 3. Navigation (`Layout.tsx`, parent)

- `{ to: '/statements', label: 'Statements' }` stays (now invoices, remittances and credits).
- Add `{ to: '/finance', label: 'Finance', show: isAdmin }` (spend / earnings reports and credits).
- Add `{ to: '/admin/finance', label: 'Agency finance', show: isPlatformAdmin }` (P&L, bank utilisation, network exports).

## 4. Simulation harness (`sim/*`, parent)

- Replace `POST /invoices/generate` with `POST /api/v1/finance/run { periodStart, periodEnd }` at each month end; the response is `{ lines, hostInvoices, remittances }`. The old endpoint still works and now also marks agency-bank lines as agency sales, but it does not produce invoices or remittances.
- After each simulated day, call `POST /api/v1/finance/jobs/run` (or the scheduler tick once section 1 is in) so overdue, reminder and credit-hold behaviour is exercised.
- Mark host invoices paid with `POST /api/v1/finance/host-invoices/:id/mark-paid { reference }` (platform admin); leave one host unpaid to see the hold.
- Hosts can raise `POST /api/v1/finance/credits { invoiceId: <settlement line id>, timesheetId?, amount, reason }` and the platform decides with `/finance/credits/:id/approve|reject`.
- `POST /api/v1/timesheets/bulk-approve { ids }` lets a host persona approve a week in one call; `GET /timesheets` rows now carry `exceptions: string[]`.
- Bank workers need `hourlyPayRate` and `contractedHoursPerWeek` (both accepted by `POST /workers`) for the agency P&L and utilisation to mean anything.

## 5. Test harness note (`test/*.test.ts`)

Build C's security gate returns `403 TWO_FACTOR_REQUIRED` for managers until an authenticator is enrolled (`platformSettings.twoFactorRequiredForManagers` defaults to true). Both `test/api.test.ts` and `test/finance.test.ts` switch it off right after `createApp`; any new suite (and the simulation harness, unless it enrols an authenticator for each manager persona) needs the same line:

```ts
db.update(platformSettings).set({ twoFactorRequiredForManagers: false }).run();
```

## 6. Shared types (`apps/web/src/api/types.ts`, parent) — optional tidy-up

`TimesheetListItem` could gain `exceptions: TimesheetException[]` and `Invoice` could gain `agencySale`, `hostInvoiceId`, `remittanceId`; until then `types.finance.ts` extends them (`TimesheetRow`, `SettlementLine`).

## 7. VAT and nominal codes

`VAT_PCT` in `services/settlement.ts` is 0 and the nominal code on the CSV export is a placeholder (`7005`); both are an accountant's decision before go-live (decision 15) and can move to `platformSettings` then.
