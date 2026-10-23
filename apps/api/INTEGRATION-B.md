# Area B (dispatch and trust): integration notes for files owned by other areas

Everything below is a snippet or a note for a file this area does not own. Nothing here is required
for the Area B tests to pass; each item closes a gap end to end.

## 1. Leaver handling (WF-02): `src/routes/workers.ts`, `PATCH /workers/:id`

When a worker is set to `INACTIVE` (or `ON_LEAVE`), release every future booking and request so hosts
are not left with a worker who will not turn up. Add the import and the call after the `db.update(workers)`:

```ts
import { cancelFutureBookingsForWorker } from '../services/assignments.js';
// …inside the PATCH handler, after db.update(workers).set({ ...patch, updatedAt: at })…
if (changes.status && changes.status !== 'ACTIVE' && worker.status === 'ACTIVE') {
  const released = cancelFutureBookingsForWorker(db, deps(req).notifier, auth(req).settings, worker.id, { userId: auth(req).user.id, orgId: worker.orgId }, `Worker is ${changes.status.toLowerCase().replace('_', ' ')}`, at);
  auditFromReq(req, db, { action: 'CANCEL', entityType: 'worker', entityId: worker.id, data: { released } }, at);
}
```

`cancelFutureBookingsForWorker(db, notifier, settings, workerId, actor, reason, now, opts?)` withdraws
REQUESTED/OFFERED rows and cancels CONFIRMED ones through `cancelAssignment` (so flag hours, timesheets and
host notifications are handled). When the actor is the supplier a cancellation inside `lateCancellationHours`
is still recorded as late, as for any supplier cancellation. `opts.hostOrgId` limits it to one host (used by bars).

## 2. Platform admin settings: `src/routes/admin.ts`, `PATCH /admin/settings`

The floor and penalty rules read these settings; make them editable (they already exist in the schema with defaults):
`nationalMinimumWage`, `employerOnCostPct`, `noShowWindowDays`, `noShowPriorityPenaltyThreshold`,
`noShowPriorityPenaltyDays`, `noShowSuspensionThreshold`, `requestReminderHours`, `requestReminderBeforeStartHours`,
`defaultEscalationMode`. `GET /shifts/floor-rate` shows the resulting floor.

Reinstating a suspended organisation (`PATCH /organisations/:id { status: 'ACTIVE' }`) already clears
`suspendedReason`; consider also clearing `priorityPenaltyUntil` there so reinstatement is complete.

## 3. Organisation settings page (web): escalation mode

`PATCH /organisations/:id` already accepts `escalationMode` ('MANUAL' | 'AUTO') and `escalationCeilingPct`.
The Settings page should expose them. Copy for the toggle: "Automatic escalation: at 48h, 24h and 12h
before the start, shifts with places unfilled get a 7% rate rise (of the original rate, up to your ceiling)
and open to every organisation. Manual: you are prompted and escalate from the shift page."

## 4. Web routing: `apps/web/src/App.tsx`

`/trust` is registered manager-only. `TrustPage` also renders a worker view (which hosts will not take them
again, via `GET /trust/me/bars`), so the route can drop the `manager` restriction:

```tsx
<Route path="/trust" element={<RequireAuth><TrustPage /></RequireAuth>} />
```

## 5. Schema suggestion (not required): `worker_bars.share_reason`

Bars store "shared with the employer" by prefixing the stored reason with `[shared] ` (read back by
`routes/trust.ts` and never exposed raw). A boolean column `share_reason` would be cleaner; if added,
switch `storeReason`/`readReason` in `src/routes/trust.ts` to it.

## 6. Scheduler and simulation harness

`tick()` returns two new fields (additive): `escalations: { auto, prompted }` and `operatorReminders`.
`POST /admin/scheduler/tick` therefore now also runs escalations and operator reminders; the sim's
`tick()` needs no change. Operator reminders go to `settings.ownerOrgId` (falls back to the AGENCY organisation).

## 7. Behaviour changes other areas should know about

- `POST /shifts`, `PATCH /shifts/:id`, `POST /shifts/:id/publish`, `POST /shifts/series`, `POST /shifts/:id/copy`
  return **422** with `details.floor` and `details.basis` when the rate is below the floor (platform admin included).
- Publishing returns **403** when the host has `creditHold` (finance area sets it on overdue invoices) or is not ACTIVE.
- Eligibility counts only CONFIRMED bookings as booked time. A REQUESTED/OFFERED row on an overlapping shift
  is a warning `PENDING_ELSEWHERE` (on `/requests`, `/eligible-workers`, `/candidates`). Confirming one withdraws
  the worker's other overlapping pending rows (note `Worker confirmed elsewhere`, host notified).
- `recordNoShow(db, notifier, settings, assignment, actor, now)` gained a `settings` argument (only `routes/assignments.ts` calls it).
- Organisations with `priorityPenaltyUntil` in the future get no surplus-flag priority; their network-tier
  reason explains why. At `noShowSuspensionThreshold` the organisation is set `SUSPENDED` with `suspendedReason`.
- Escalations are written to `audit_log` as `{ action: 'UPDATE', entityType: 'shift', data: { escalation } }`.
