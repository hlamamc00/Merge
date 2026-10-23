# Merge

**Merge is a staff-exchange platform for care providers.** When one care company is short-staffed it posts shifts; when another has more staff than hours it lends them. The platform can be operated by a staffing agency that also runs its own bank of workers, and it uses **capacity flags** so that organisations which have declared surplus staff receive matching shifts *first*.

```
  Oakwood Care (short-staffed)            Riverside Living (surplus flag: 3 care assistants, 60h)
        │  posts "Day shift – Maple unit"          │
        ▼                                          │
  ┌──────────────────────── staged release ────────┴───────────────────────┐
  │ 0:00  PRIORITY   Riverside + other surplus-flagged / preferred orgs     │
  │ 2:00  AGENCY     Merge Staffing's own bank                              │
  │ 3:00  NETWORK    everyone else                                          │
  │ (urgent shifts: every stage opens immediately)                          │
  └─────────────────────────────────────────────────────────────────────────┘
        ▲                                          │
        │  confirms Aisha (eligibility checked:     ▼ puts Aisha forward (manager) – or Aisha picks it
        │  role, skills, DBS/RTW/training valid       herself if self-service is on
        │  on the shift date, 11h rest, 48h week)
  clock in/out → timesheet → approval → statement (host pays, platform fee, supplier receives)
```

## What is in the box

| Area | Highlights |
| --- | --- |
| **Organisations** | Agency (platform owner) and provider organisations register with their regulator number, accept the MOU and are approved by the platform; sites; users with four roles, managers optionally limited to sites; authenticator two-factor, lockout and forced password change; preferred-partner and block lists; directory. |
| **Workers** | Profiles, roles with a cover matrix (a nurse may cover a senior-carer shift, not vice versa), skills, shareable flag, spreadsheet import with email invitations, compliance documents with files, verification queue, versioning and expiry, host-specific requirements, worker self-upload, actual hours per week, unavailability, data export and erasure. |
| **Capacity flags** | `SURPLUS` ("our staff are short of hours") → priority access to matching shifts, consumed as hours are booked; the flag names the staff it frees so their contracted hours stop counting against the 48-hour limit; expiry nudges. `SHORTAGE` ("we will be posting") → visible demand. Network supply/demand view. |
| **Shifts & dispatch** | Post (above a platform-wide floor rate), repeat weekly or copy, preview *who will see it and when*, publish with a persisted staged release plan, urgent collapse, automatic or manual escalation of unfilled shifts (rate steps up to a ceiling, widened reach), board sorted by distance, rate or start with per-worker eligibility, direct offers, candidate search, bulk confirm. |
| **Eligibility** | Explained, not just enforced: role, skills, compliance *as of the shift date*, host requirements and bars, access window, overlaps, 11 h rest, 48 h week counting contracted hours unless the employer records otherwise (opt-out override), travel distance, breaks; re-checked when a request is confirmed. |
| **Bookings** | Request / offer / confirm / decline / withdraw / cancel (late-cancellation tracking) / no-show; requests are soft holds until confirmed; auto-confirm; automatic decline of the rest when a shift fills; leavers' future bookings released. |
| **Trust & safety** | Reliability record per organisation and worker, host bars on individual workers, reports (attendance, conduct, safeguarding) routed to the employer, priority penalty and suspension for repeated no-shows. |
| **Timesheets & money** | Clock in/out (with location), submit, dispute, approve or bulk-approve with exceptions highlighted, auto-approval after 14 days; host invoices and supplier remittances each month (hosts pay the platform, the platform pays suppliers), credits, overdue reminders and credit hold, CSV exports, spend and earnings reports, agency P&L and bank utilisation, per-site workforce report for inspections; ratings both ways. |
| **Operations** | Notifications in-app and by email (immediate or daily digest, quiet hours, per-user preferences), background scheduler (opens tiers, escalates, expires flags, starts/completes/expires shifts, reminders, finance jobs, document-expiry alerts, retention purge), audit log, admin settings and overview. |

See **[docs/FEATURE-ROADMAP.md](docs/FEATURE-ROADMAP.md)** for the recommended next features.

## Repository layout

```
packages/shared   Domain enums, the dispatch/priority engine and eligibility rules (pure TypeScript, unit-tested)
apps/api          Express + Drizzle ORM + SQLite REST API, scheduler, seed data, integration tests
apps/web          React + Vite web app for providers, the agency and workers
docs/             Architecture, domain model, dispatch rules, API reference, roadmap
```

## Quick start

Requirements: Node 24 LTS (the repo pins it in `.nvmrc`) and npm 11+. On Windows, install Node 24 before running `npm install`; the database library is compiled from source on other versions, which needs Visual Studio Build Tools.

```bash
npm install
npm run db:migrate          # creates apps/api/data/merge.db
npm run db:seed             # demo agency, four providers, workers, flags, shifts
npm run dev:api             # http://localhost:4000
npm run dev:web             # http://localhost:5173 (proxies /api to the API)
```

Demo logins (password `password123`):

| Email | Who |
| --- | --- |
| `admin@merge.local` | Platform admin – Merge Staffing (the agency; also runs its own bank) |
| `bank@merge.local` | Agency bank manager |
| `admin@oakwood.local` | Oakwood Care Homes – short-staffed, posting shifts |
| `admin@riverside.local` | Riverside Living – has a surplus flag, so gets priority access |
| `admin@brighthorizons.local` | Bright Horizons Support – surplus support workers |
| `admin@pennine.local` | Pennine Nursing – nurse shortage |
| `aisha@riverside.local` | A care worker whose employer allows self-service shift pick-up |

Demo logins have authenticator two-factor switched off by the seed; production keeps it compulsory for admins and managers (see `docs/DECISIONS.md`, decision 16).

Useful commands:

```bash
npm test                    # shared rules + API integration tests
npm run typecheck
npm run build
npm run db:reset && npm run db:migrate && npm run db:seed   # start over
```

Configuration lives in `apps/api/.env.example` (database path, port, JWT secret, CORS origins, scheduler interval, `WEB_URL` for emailed links, `SMTP_URL`/`MAIL_FROM` for email delivery, file storage directory). Without `SMTP_URL`, emails are printed to the API console.

### Docker

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build   # API on :4000, web on :8080, SQLite volume persisted
```

The API refuses to start with `NODE_ENV=production` unless `JWT_SECRET` is a random value of at least 32 characters.

## How priority works (short version)

1. An organisation raises a **SURPLUS** capacity flag: role (or any), hours it wants to place, period, optional postcode areas / radius.
2. When a shift is published the engine builds a **release plan**: organisations whose active flags match the shift's role, time and place (plus the host's preferred partners) are in the **PRIORITY** tier and are notified immediately, ordered by flag age (first to flag, first notified). The agency's own bank and the wider network open later, after configurable windows. If the shift starts soon the windows collapse and everyone is released at once.
3. Only an organisation whose tier is open can put a worker forward. Every booking against a flag consumes its hours; once fulfilled the flag closes and the organisation drops back to normal access until it flags again.
4. A newly raised surplus flag also promotes the organisation on shifts that are *already* open.

Full details, including the agency-position settings and worked examples, are in [docs/DISPATCH-AND-PRIORITY.md](docs/DISPATCH-AND-PRIORITY.md).

## Market-entry simulation

`npm run sim -w @merge/api` plays out six months of adoption by twenty providers and an agency bank through the real API, and writes [docs/SIMULATION-REPORT.md](docs/SIMULATION-REPORT.md): fill rates, time to fill, calls per human task, and a gap register of everything that was impossible, clumsy or silently wrong. See [apps/api/sim/README.md](apps/api/sim/README.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – stack, modules, request flow, scheduler, deployment notes
- [docs/DOMAIN-MODEL.md](docs/DOMAIN-MODEL.md) – entities, states and relationships
- [docs/DISPATCH-AND-PRIORITY.md](docs/DISPATCH-AND-PRIORITY.md) – the capacity-flag priority system
- [docs/API.md](docs/API.md) – REST endpoints
- [docs/FEATURE-ROADMAP.md](docs/FEATURE-ROADMAP.md) – suggested features to make the platform comprehensive
- [docs/SIMULATION-REPORT.md](docs/SIMULATION-REPORT.md) – six-month market-entry simulation: metrics and gap register
- [docs/DECISIONS.md](docs/DECISIONS.md) – product decisions taken in response to the simulation
