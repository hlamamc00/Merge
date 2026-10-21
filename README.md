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
| **Organisations** | Agency (platform owner) and provider organisations, sites, users with four roles, preferred-partner and block lists, directory. |
| **Workers** | Profiles, roles with a cover matrix (a nurse may cover a senior-carer shift, not vice versa), skills, shareable flag, compliance documents with verification and expiry, unavailability, optional self-service login. |
| **Capacity flags** | `SURPLUS` ("our staff are short of hours") → priority access to matching shifts, consumed as hours are booked. `SHORTAGE` ("we will be posting") → visible demand. Network supply/demand view. |
| **Shifts & dispatch** | Post, preview *who will see it and when*, publish with a persisted staged release plan, urgent collapse, visibility modes (network / priority-only / preferred-only / agency-only), direct offers to named workers, candidate search. |
| **Eligibility** | Explained, not just enforced: role, skills, compliance *as of the shift date*, access window, overlaps, 11 h rest, weekly hours cap with 48 h opt-out override, travel distance, breaks. |
| **Bookings** | Request / offer / confirm / decline / withdraw / cancel (late-cancellation tracking) / no-show; auto-confirm; automatic decline of the rest when a shift fills. |
| **Timesheets & money** | Clock in/out (with location), submit, dispute, approve; host cost, platform fee and supplier amount per timesheet; statements per host/supplier pair; ratings both ways. |
| **Operations** | In-app notifications with pluggable channels, background scheduler (opens tiers, expires flags, starts/completes/expires shifts, unfilled warnings, document-expiry alerts), audit log, admin settings and overview. |

See **[docs/FEATURE-ROADMAP.md](docs/FEATURE-ROADMAP.md)** for the recommended next features.

## Repository layout

```
packages/shared   Domain enums, the dispatch/priority engine and eligibility rules (pure TypeScript, unit-tested)
apps/api          Express + Drizzle ORM + SQLite REST API, scheduler, seed data, integration tests
apps/web          React + Vite web app for providers, the agency and workers
docs/             Architecture, domain model, dispatch rules, API reference, roadmap
```

## Quick start

Requirements: Node 20+ (22 recommended) and npm 10+.

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

Useful commands:

```bash
npm test                    # shared rules + API integration tests
npm run typecheck
npm run build
npm run db:reset && npm run db:migrate && npm run db:seed   # start over
```

Configuration lives in `apps/api/.env.example` (database path, port, JWT secret, CORS origins, scheduler interval).

### Docker

```bash
docker compose up --build   # API on :4000, web on :8080, SQLite volume persisted
```

## How priority works (short version)

1. An organisation raises a **SURPLUS** capacity flag: role (or any), hours it wants to place, period, optional postcode areas / radius.
2. When a shift is published the engine builds a **release plan**: organisations whose active flags match the shift's role, time and place (plus the host's preferred partners) are in the **PRIORITY** tier and are notified immediately, ordered by flag age (first to flag, first notified). The agency's own bank and the wider network open later, after configurable windows. If the shift starts soon the windows collapse and everyone is released at once.
3. Only an organisation whose tier is open can put a worker forward. Every booking against a flag consumes its hours; once fulfilled the flag closes and the organisation drops back to normal access until it flags again.
4. A newly raised surplus flag also promotes the organisation on shifts that are *already* open.

Full details, including the agency-position settings and worked examples, are in [docs/DISPATCH-AND-PRIORITY.md](docs/DISPATCH-AND-PRIORITY.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – stack, modules, request flow, scheduler, deployment notes
- [docs/DOMAIN-MODEL.md](docs/DOMAIN-MODEL.md) – entities, states and relationships
- [docs/DISPATCH-AND-PRIORITY.md](docs/DISPATCH-AND-PRIORITY.md) – the capacity-flag priority system
- [docs/API.md](docs/API.md) – REST endpoints
- [docs/FEATURE-ROADMAP.md](docs/FEATURE-ROADMAP.md) – suggested features to make the platform comprehensive
