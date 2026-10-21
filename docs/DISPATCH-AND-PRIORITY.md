# Dispatch and priority

This is the part of Merge that answers: *when a shift is posted, who gets it first?*

## The problem it solves

Without priority rules a shift exchange is a free-for-all: whoever refreshes fastest wins, and the organisation that most needs to place its staff is no better off than one that is merely opportunistic. Merge lets an organisation **declare, at a point in time, that it has staff short of hours** (a `SURPLUS` capacity flag). While that flag is active and unfulfilled, matching shifts are released to that organisation **before** the wider network.

## Tiers

| Tier | Who | Default opens at |
| --- | --- | --- |
| **PRIORITY** | Organisations with an active, unfulfilled `SURPLUS` flag that matches the shift (see *Matching*), plus the host's preferred partners (configurable). Ordered by flag age: first to flag, first notified. | publish time |
| **AGENCY** | The platform-owning agency's own bank. Its position is a platform setting (below). | publish + 120 min |
| **NETWORK** | Every other active organisation not blocked by / blocking the host. Ordered by distance when coordinates are known. | publish + 180 min |

The host organisation never appears in its own plan; covering a shift with your own staff is an internal rota matter.

### Agency position

The agency owning the platform decides where its bank sits (`agencyPosition`):

| Setting | Order | Use when |
| --- | --- | --- |
| `FIRST` | agency → priority → network | The agency wants to fill with its own bank first (margin-first). |
| `WITH_PRIORITY` | agency + priority → network | The bank is treated like any surplus-flagged provider. |
| `AFTER_PRIORITY` (default) | priority → agency → network | Partners' surplus staff first, then the bank, then everyone. |
| `WITH_NETWORK` | priority → agency + network | The bank competes with the open network. |
| `LAST` | priority → network → agency | The bank is a safety net for shifts nobody else takes. |

If the agency itself raises a matching surplus flag, its bank never waits longer than the priority tier regardless of position.

### Windows and urgency

- `priorityWindowMinutes` (default 120) and `agencyWindowMinutes` (default 60) are platform settings; a host may override the priority window per shift: longer for a shift far in the future, or **0 to release every tier at once** (priority organisations are still notified first).
- **Urgent**: if the shift starts within `urgentThresholdMinutes` (default 12 h) of publication, every stage opens immediately and the shift is flagged urgent. Priority organisations are still notified first (ordering), they just do not get exclusivity.
- **Minimum lead**: no stage may open later than `minLeadBeforeStartMinutes` (default 60) before the shift starts, so windows are clamped for shifts posted at short notice.

### Visibility modes

| `visibility` | Effect |
| --- | --- |
| `NETWORK` (default) | Full staged release. |
| `PRIORITY_ONLY` | Only priority organisations (and the agency); never opens to the network. |
| `PREFERRED_ONLY` | Only the host's preferred partners, immediately. |
| `AGENCY_ONLY` | Only the agency bank, immediately. |

Blocked organisations (either direction) are excluded in every mode.

## Matching a surplus flag to a shift

A flag matches when **all** of these hold:

1. `hoursFilled < hoursRequested` (the flag still has hours to place);
2. the flag's role is empty (any role) **or** a worker of that role may cover the shift's role (`ROLE_COVERS`), e.g. a senior-carer flag matches a care-assistant shift;
3. the flag's period overlaps the shift;
4. geography: if the flag lists postcode areas, the site's postcode area (the leading letters, e.g. `M`, `SK`) must be one of them; if the flag has a radius and both sides have coordinates, the site must be within it.

If an organisation has several matching flags the oldest is used.

## Hour accounting and fairness

- Confirming a booking against a priority entry adds the shift's **paid hours** (duration minus unpaid break) to the matched flag's `hoursFilled`. When the flag reaches its request it becomes `FULFILLED` and the organisation is notified; it then receives shifts at normal network timing until it raises a new flag.
- Cancelling a confirmed booking gives the hours back (and reactivates a fulfilled flag if its period has not ended).
- Every assignment records `tierAtRequest` and `matchedFlagId`, so the agency can report how much work flowed through priority access versus the open network.
- Raising a surplus flag **promotes** the organisation on shifts that are already open (its access time is only ever brought forward, never pushed back for anyone else).

## Worked example (default settings)

Oakwood publishes a care-assistant day shift at 08:00 for the day after tomorrow.

| Organisation | State | Tier | Opens |
| --- | --- | --- | --- |
| Riverside Living | SURPLUS flag, care assistants, 60h, areas M/SK, raised yesterday | PRIORITY #1 | 08:00 |
| Bright Horizons | SURPLUS flag, support workers | NETWORK (role cannot cover) | 11:00 |
| Northern Care (preferred partner) | no flag | PRIORITY #2 | 08:00 |
| Merge Staffing (agency bank) | – | AGENCY | 10:00 |
| Pennine Nursing | no flag | NETWORK | 11:00 |
| Suspended Ltd | suspended | excluded | – |

At 08:00 Riverside and Northern are notified. Riverside's manager sees "Priority access – Surplus flag: 60h of 60h remaining, care assistant" and puts Aisha forward; Oakwood confirms; Riverside's flag drops from 60h to 49h remaining (a 12 h shift with a 1 h unpaid break is 11 paid hours). With `headcount: 1` the shift is now FILLED and nobody else is released. If it had `headcount: 2` it would stay open, the agency bank would be released at 10:00 and Pennine at 11:00.

If Oakwood had posted the same shift at 20:00 the evening before (lead time 11 h < 12 h threshold) the shift would be urgent and all four would be released at 20:00, with Riverside still first in the notification order.

## Eligibility: who can be put forward once a tier is open

Access is necessary but not sufficient. `evaluateEligibility` returns **blockers** (the request is refused) and **warnings** (shown to the manager):

| Blocker | Rule |
| --- | --- |
| `ACCESS_NOT_OPEN` / `NO_ACCESS` | The organisation's tier has not opened / it is not in the plan. |
| `OWN_ORGANISATION` | A host cannot "borrow" its own worker through the exchange. |
| `WORKER_INACTIVE`, `WORKER_NOT_SHAREABLE` | Employer controls. |
| `ROLE_MISMATCH`, `MISSING_SKILLS` | Cover matrix and required skills. |
| `NON_COMPLIANT` | A required document is missing, unverified or expired **on the shift date**. |
| `OVERLAPPING_SHIFT`, `INSUFFICIENT_REST` | Clash with another platform booking, or less than 11 h (configurable) between shifts. |
| `WEEKLY_HOURS_EXCEEDED` | Platform bookings + declared internal hours in the Monday–Sunday week would exceed the lower of the worker's cap and the platform's cap (48 h). A manager may override only for workers with a 48 h opt-out on file; it is then a warning. |
| `WORKER_UNAVAILABLE` | Overlaps an unavailability window the worker/employer recorded. |
| `SHIFT_TOO_LONG`, `SHIFT_IN_PAST` | Platform limits. |

Warnings: `DOCUMENT_EXPIRING`, `LONG_SHIFT` (> 12 h), `INSUFFICIENT_BREAK` (> 6 h with < 20 min break), `OUT_OF_TRAVEL_RANGE`.

The same function is exposed to the UI (`GET /shifts/:id/eligible-workers`) so managers see *why* a worker cannot be sent before they try.
