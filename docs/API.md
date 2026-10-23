# REST API

Base URL `/api/v1`. JSON in and out. Authenticate with `Authorization: Bearer <token>`. Errors are `{ error, details? }`; validation errors are `400` with a Zod `details` object; eligibility refusals are `422` with `details.blockers[]` and `details.warnings[]`.

Roles: **PA** platform admin (agency), **OA** org admin, **OM** org manager, **W** worker. "Managers" = PA, OA, OM. Platform admins may pass `orgId` on most organisation-scoped calls to act for another organisation.

## Auth
| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/auth/bootstrap` | – | First-run: create the agency and its first platform admin. Once only. |
| POST | `/auth/register` | – | Create a provider organisation (status `PENDING`) and its admin. Returns `{ token, user, organisation }`. The platform admin approves it with `PATCH /organisations/:id { status: ACTIVE }`; until then it can set up workers and sites but cannot publish or receive shifts. |
| POST | `/auth/login` | – | `{ email, password }` → `{ token, user, organisation }` |
| GET | `/auth/me` | any | `{ user, organisation, worker?, platform }` |

## Organisations
| Method | Path | Who |
| --- | --- | --- |
| GET | `/organisations` | any (directory; PA sees everything) |
| GET | `/organisations/:id` | any |
| PATCH | `/organisations/:id` | OA/PA (`status` only PA) |
| GET | `/organisations/:id/stats` | managers |
| GET/POST | `/organisations/:id/sites` | own organisation / managers |
| PATCH/DELETE | `/organisations/:id/sites/:siteId` | managers |
| GET | `/organisations/:id/relationships` | managers |
| PUT/DELETE | `/organisations/:id/relationships/:otherOrgId` | OA/PA – body `{ kind: PREFERRED|BLOCKED, note? }` |
| GET/POST | `/organisations/:id/users` | OA/PA |
| PATCH | `/organisations/:id/users/:userId` | OA/PA |

## Workers
| Method | Path | Who |
| --- | --- | --- |
| GET | `/workers?orgId&status&jobRole` | managers (with compliance summary) |
| POST | `/workers` | managers |
| GET | `/workers/:id` | managers of the employer, or the worker |
| PATCH | `/workers/:id` | managers |
| POST | `/workers/:id/login` | managers – `{ email, password }` gives the worker a login |
| POST | `/workers/:id/documents` | managers |
| PATCH | `/workers/:id/documents/:docId` | managers – include `verified: true|false` |
| DELETE | `/workers/:id/documents/:docId` | managers |
| POST/DELETE | `/workers/:id/unavailability[/:id]` | managers or the worker |
| GET | `/workers/:id/weeks?from&to` | managers – hours with the employer per ISO week (decision 8): `[{ weekStart, internalHours, contractedHoursPerWeek, source: RECORDED\|FLAG\|CONTRACT, note, sourceFlagId }]`; defaults to this week and the eight after it |
| PUT | `/workers/:id/weeks/:weekStart` | managers – `{ internalHours (0–168), note? }`; `:weekStart` is `YYYY-MM-DD` and must be a Monday (Europe/London), else `422`. Replaces the contracted hours in the 48h check for that week |
| DELETE | `/workers/:id/weeks/:weekStart` | managers – back to the contracted hours (`204`) |
| POST | `/workers/week-hours` | managers – `{ weekStart: 'YYYY-MM-DD', entries: [{ workerId, internalHours }] }` (1–500) → `{ updated }`; `404` unknown worker, `403` another organisation's |

## Capacity flags
| Method | Path | Who |
| --- | --- | --- |
| GET | `/capacity/flags?orgId&status&kind` | managers – each row carries `hoursRemaining` and `releasedWorkers` |
| POST | `/capacity/flags` | managers – `{ kind, jobRole?, headcount, hoursRequested, startsAt, endsAt, siteId?, postcodeAreas?, radiusKm?, note?, workerIds?, releasedHours? }`. `workerIds` (SURPLUS only, else `422`; each must be an active, shareable worker of the organisation, else `404`) names the staff who are free: they are recorded with `releasedHours` (default 0) hours with their employer for every week of the flag (decision 8). Returns the flag plus `hoursRemaining` and `workersReleased` |
| POST | `/capacity/flags/:id/withdraw` | managers – also puts the staff the flag freed back on their contracted hours from the current week on |
| GET | `/capacity/network` | any – `{ summary[], flags? }` (flags itemised for PA only) |

## Shifts
| Method | Path | Who |
| --- | --- | --- |
| GET | `/shifts?scope=posted|available|supplied|all&status&jobRole&from&to&includePast` | see below |
| POST | `/shifts` | managers – shift fields + `publish: boolean` |
| GET | `/shifts/:id` | host, platform admin, or an organisation in its plan (`isHost`, `canManage`). Site access notes are included only for the host or an organisation with a confirmed booking; worker logins do not receive `chargeRate`. |
| PATCH | `/shifts/:id` | host managers (full edit while DRAFT; limited while OPEN) |
| POST | `/shifts/:id/publish` | host managers |
| POST | `/shifts/:id/cancel` | host managers – `{ reason? }` |
| GET | `/shifts/:id/dispatch-preview` | host managers – who will see it and when |
| GET | `/shifts/:id/eligible-workers?allowHoursOverride` | supplier managers – my workers with eligibility |
| GET | `/shifts/:id/candidates` | host managers – eligible shareable workers from organisations whose tier is open |
| POST | `/shifts/:id/requests` | supplier managers `{ workerId, allowHoursOverride?, note? }`; workers `{}` for themselves |
| POST | `/shifts/:id/offers` | host managers – `{ workerId }` |

Scopes: `posted` = my organisation hosts (managers); `available` = released or scheduled to be released to my organisation (includes `access: { tier, opensAt, open, reason }`; workers only see shifts their role can cover and only if self-service is enabled); `supplied` = my organisation's assignments; `all` = PA.

## Assignments
| Method | Path | Who |
| --- | --- | --- |
| GET | `/assignments?scope=incoming|outgoing&status=A,B` | any |
| GET | `/assignments/:id` | host, supplier or the worker |
| POST | `/assignments/:id/confirm` | host managers (REQUESTED → CONFIRMED) |
| POST | `/assignments/:id/accept` | supplier or worker (OFFERED → CONFIRMED) |
| POST | `/assignments/:id/decline` | host (requests) / supplier or worker (offers) – `{ reason? }` |
| POST | `/assignments/:id/withdraw` | supplier or worker (REQUESTED) |
| POST | `/assignments/:id/cancel` | host or supplier managers (CONFIRMED) – `{ reason? }` |
| POST | `/assignments/:id/no-show` | host managers, after the start |
| POST | `/assignments/:id/rating` | host or supplier managers – `{ score 1–5, comment? }` |

## Timesheets
| Method | Path | Who |
| --- | --- | --- |
| GET | `/timesheets?scope=payable|receivable|all&status=A,B` | any (workers: own) |
| GET | `/timesheets/:id` | host, supplier or worker |
| POST | `/timesheets/:id/clock-in` | supplier or worker – `{ at?, lat?, lng? }` |
| POST | `/timesheets/:id/clock-out` | supplier or worker – `{ at?, breakMinutes? }` → SUBMITTED |
| POST | `/timesheets/:id/submit` | supplier or worker – `{ clockInAt, clockOutAt, breakMinutes, notes? }` |
| POST | `/timesheets/:id/approve` | host managers |
| POST | `/timesheets/:id/dispute` | host managers – `{ reason }` |
| POST | `/timesheets/:id/reject` | host managers – `{ reason }` |

## Statements (invoices)
| Method | Path | Who |
| --- | --- | --- |
| GET | `/invoices?scope=payable|receivable|all` | OA/PA |
| GET | `/invoices/:id` | OA/PA (party to it) – includes `lines[]` |
| POST | `/invoices/generate` | OA (own org) / PA – `{ periodStart, periodEnd, hostOrgId?, supplierOrgId? }`. Bills every approved, not-yet-invoiced timesheet for shifts starting before `periodEnd`, so late approvals are caught up on the next run. |
| POST | `/invoices/:id/mark-paid` | OA/PA |

## Notifications
| Method | Path |
| --- | --- |
| GET | `/notifications?unread&limit` → `{ unread, notifications[] }` |
| POST | `/notifications/:id/read`, `/notifications/read-all` |

## Admin (PA only)
| Method | Path |
| --- | --- |
| GET/PATCH | `/admin/settings` |
| GET | `/admin/overview` |
| GET | `/admin/audit?entityType&entityId&limit` |
| POST | `/admin/scheduler/tick` |

`GET /api/health` is unauthenticated.

## Changes: platform fixes after the simulation

### Confirmation re-checks eligibility
Requests and offers are soft holds (decision 7), so a worker's position can change before the host answers. `POST /assignments/:id/confirm`, `POST /assignments/:id/accept` and `POST /assignments/bulk { action: confirm }` now re-run the eligibility rules against the shift at confirmation time, with the same `allowHoursOverride` the request carried. Access-window codes (`ACCESS_NOT_OPEN`, `NO_ACCESS`) are ignored, since the pending row already had access; every other blocker counts (`WEEKLY_HOURS_EXCEEDED`, `INSUFFICIENT_REST`, `OVERLAPPING_SHIFT`, `NON_COMPLIANT`, `BARRED_BY_HOST`, `WORKER_NOT_SHAREABLE`, `MISSING_SKILLS`, …).

When a blocker is found the assignment is set to `DECLINED` with note `No longer eligible at confirmation: <first blocker>`, the supplier gets a `SHIFT_DECLINED` notification (`data.kind = 'no-longer-eligible'`, `data.blockers[]`), a `DECLINE` audit entry records the blockers, and the call fails:

```
409 { error: "<worker> is no longer eligible: <messages>", details: { code: "NO_LONGER_ELIGIBLE", blockers: [{ code, message }] } }
```

The bulk endpoint reports it per row: `{ id, ok: false, error, details: { code: "NO_LONGER_ELIGIBLE", blockers } }` (rows now carry `details` whenever the failure has structured details). The worker's other pending requests are not touched; the shift stays open.

### Document expiry alerts reach the worker
The scheduler's `DOCUMENT_EXPIRING` alert (documents expiring within 30 days, at most once a week per document) is also sent to the worker when they have a login: a second notification with `userId` set, worded for them ("Your <document> expires in N days. Upload the renewed certificate from My documents so you can keep taking shifts."). Managers keep seeing only the organisation-wide copy; the worker sees only theirs.

### `FLAG_EXPIRED` notification
New `NotificationType.FLAG_EXPIRED`, emailed immediately by default. When the scheduler expires a `SURPLUS` flag whose period has passed, the organisation gets one notice: title `Your surplus flag has expired`, body `Your <role or 'any role'> surplus flag ran out on <date>. Raise it again from Capacity flags if you still have spare staff; without an active flag you no longer get first access.`, `data: { flagId, kind, jobRole }`. Shortage flags expire silently.

### Suspension side effects (`PATCH /organisations/:id { status: SUSPENDED }`)
Platform admin only. When the organisation was not already suspended:

1. Every `DRAFT`, `OPEN` or `FILLED` shift it hosts that has not started is cancelled (`cancellationReason` starts `Organisation suspended`). Live requests, offers and confirmed bookings on those shifts are cancelled too, without a late-cancellation mark, and each supplier gets `SHIFT_CANCELLED`; a suspended host cannot receive staff. Cancelled shifts drop off every organisation's available board.
2. Confirmed bookings of the organisation's own workers at other hosts that have not started are left in place. Each such host gets one `SYSTEM` notification (`data.kind = 'supplier-suspended'`, `data.assignmentIds[]`): "<org> has been suspended from the network; your confirmed booking(s) with its staff on <dates> stand. Contact the platform if you want them re-covered."
3. The `UPDATE` audit entry carries `{ shiftsCancelled, bookingsHonoured }`.
4. The response is the organisation row plus `effects: { shiftsCancelled, bookingsHonoured }`.

Suspending an already-suspended organisation, or reinstating it (`status: ACTIVE`), returns the row without `effects` and changes nothing else. An unknown organisation is `404`.

## Reports
| Method | Path | Who |
| --- | --- | --- |
| GET | `/reports/workforce?orgId&siteId&from&to&format=json|csv` | host OA/OM (a site-limited manager: their sites only) / PA for any `orgId`. Defaults: the caller's organisation, the last 90 days. Every CONFIRMED, COMPLETED or NO_SHOW booking on the host's shifts starting in `[from, to]` → `{ orgId, siteId, from, to, rows[], summary: { shifts, workers, employers, nonCompliantOnDay } }`; each row `{ shiftId, siteId, siteName, shiftDate (Europe/London), startsAt, endsAt, jobRole, shiftTitle, workerId, workerName, employerOrgId, employerName, attendance, paidHours, timesheetStatus, documents: { [type]: VALID|EXPIRED|UNVERIFIED|MISSING }, compliantOnDay }`, judged as of the shift date from the full document history (decision 13: status only, never references or pay). `format=csv` returns `text/csv` as `workforce-<site>-<from>-<to>.csv` with one column per document type. |

## Worker data (decision 18)
| Method | Path | Who |
| --- | --- | --- |
| GET | `/workers/:id/export?download=1` | the worker's own login, employer OA or unrestricted OM, PA → `{ exportedAt, worker, login, consent, documents (incl. superseded history, never file keys), unavailability, weekHours, assignments, timesheets, ratings, bars, reports }`; `download=1` adds `Content-Disposition: attachment; filename="worker-<id>.json"`. |
| POST | `/workers/:id/erasure-request` | the worker's own login → 202 `{ requestedAt }`; every ORG_ADMIN of the employer is notified (SYSTEM) and the request is audited. |
| POST | `/workers/:id/erase` | employer OA / PA – `{ reason }` → `{ erasedAt, kept: ['timesheets', 'invoices', 'ratings', 'audit'] }`. 409 while the worker is ACTIVE, still has a REQUESTED/OFFERED/CONFIRMED assignment on a shift that has not started, or is already erased. Replaces the name with "Former Worker"; clears contact details, location, notes, skills and sharing; deletes documents (and their files), unavailability, week hours and the login's notification preferences; disables the login with a scrambled email and password and no authenticator. Timesheets, invoices, rating scores and the audit trail are kept. |
