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

## Capacity flags
| Method | Path | Who |
| --- | --- | --- |
| GET | `/capacity/flags?orgId&status&kind` | managers |
| POST | `/capacity/flags` | managers – `{ kind, jobRole?, headcount, hoursRequested, startsAt, endsAt, siteId?, postcodeAreas?, radiusKm?, note? }` |
| POST | `/capacity/flags/:id/withdraw` | managers |
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
