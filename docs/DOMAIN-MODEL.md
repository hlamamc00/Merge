# Domain model

```
Organisation (AGENCY | PROVIDER) ──< Site
      │ ──< User (PLATFORM_ADMIN | ORG_ADMIN | ORG_MANAGER | WORKER)
      │ ──< Worker ──< WorkerDocument
      │                └──< WorkerUnavailability
      │ ──< CapacityFlag (SURPLUS | SHORTAGE)
      │ ──< OrgRelationship (PREFERRED | BLOCKED) >── Organisation
      │
      └──< Shift (host) ──< ShiftAccess >── Organisation   (the persisted release plan)
                        ──< ShiftAssignment >── Worker, Organisation (supplier)
                                   └── Timesheet ── Invoice
                                   └──< Rating
Notification, AuditLog, PlatformSettings
```

## Organisation
An **AGENCY** owns the platform; there is one, created by `POST /auth/bootstrap`. It may have its own workers ("the bank") which take part in the exchange like any other supplier, but at a configurable position in the release order. **PROVIDER** organisations are care companies. Status `PENDING | ACTIVE | SUSPENDED`. `workerSelfServiceAllowed` controls whether its workers may request shifts themselves.

## Worker
Belongs to exactly one employer. `jobRole` with a cover matrix (`ROLE_COVERS`): a worker may cover a shift whose role is in their row (nurse → nurse, team leader, senior carer, care assistant, support worker; care assistant → care assistant, support worker; …). `skills` are capability tags matched against a shift's `requiredSkills`. `shareable` is the employer's consent to lend the worker. `maxHoursPerWeek`, `optedOutOf48h`, `travelRadiusKm`, location. `hourlyPayRate` is private to the employer.

## WorkerDocument
Compliance evidence: `DBS`, `RIGHT_TO_WORK`, `PHOTO_ID`, `REFERENCES`, `MANDATORY_TRAINING`, `MOVING_AND_HANDLING_TRAINING`, `SAFEGUARDING_TRAINING`, `MEDICATION_TRAINING`, `NMC_PIN`. Required set depends on role (`requiredDocumentsForRole`). A document counts only when **verified** and not expired *on the shift date*. Status: `VALID | EXPIRING (≤30 days) | EXPIRED | PENDING_VERIFICATION | MISSING`.

## CapacityFlag
Raised by an organisation at a point in time.
- `kind = SURPLUS`: "we have staff short of hours". Fields: optional `jobRole` (null = any), `headcount`, `hoursRequested`, `hoursFilled`, `startsAt`/`endsAt`, geography (`postcodeAreas` and/or `radiusKm`), note. While `ACTIVE` and unfulfilled it places the organisation in the priority tier of matching shifts. Confirmed bookings add the shift's paid hours to `hoursFilled`; cancellations give them back. Status `ACTIVE | FULFILLED | EXPIRED | WITHDRAWN`.
- `kind = SHORTAGE`: "we are short-staffed and will post shifts". Informational today (network demand view, admin overview); see the roadmap for proactive matching.

## Shift
Posted by a host organisation at one of its sites. `jobRole`, times, `breakMinutes` (unpaid), `headcount`, `requiredSkills`, `extraRequiredDocuments`, `chargeRate` (what the host pays per paid hour), `visibility`, `priorityWindowMinutesOverride`, `autoConfirm`. Status: `DRAFT → OPEN → FILLED → IN_PROGRESS → COMPLETED`, or `CANCELLED`, or `EXPIRED` (started with nobody confirmed). `urgent` is set when the lead time at publication is below the platform's urgent threshold.

## ShiftAccess
One row per organisation that will be able to see the shift: `tier` (`PRIORITY | AGENCY | NETWORK`), `opensAt`, `rank` within the tier, human-readable `reason` (e.g. "Surplus flag: 32.5h of 40h remaining, care assistant"), `matchedFlagId`, `notifiedAt`.

## ShiftAssignment
A worker's involvement with a shift. `REQUESTED` (supplier → host) or `OFFERED` (host → worker) become `CONFIRMED`, or end `DECLINED | WITHDRAWN`. A confirmed booking may be `CANCELLED` (with `lateCancellation` when the supplier cancels inside the platform's late window) or recorded as `NO_SHOW`; it becomes `COMPLETED` when its timesheet is approved. Records `tierAtRequest` and `matchedFlagId` for fairness reporting.

## Timesheet
Created as `DRAFT` on confirmation. The supplier side (manager or worker) clocks in/out (optionally with location) or submits times manually → `SUBMITTED`; the host → `APPROVED`, `DISPUTED` (supplier corrects and resubmits) or `REJECTED`. If the booking is cancelled or marked a no-show, a draft timesheet is deleted and a submitted one is rejected; times can only be processed while the booking is `CONFIRMED`. Money is snapshotted at confirmation: `chargeRate`, `platformFeePct`, and computed `paidHours`, `hostCost`, `platformFee`, `supplierAmount`.

## Invoice (statement)
Generated for a period per host/supplier pair from approved, un-invoiced timesheets. `subtotal` is what the host owes; `platformFee` is retained by the platform; `supplierAmount` is paid to the supplier. Status `ISSUED → PAID`.

## Rating
Once per side per assignment: host rates the worker (score 1–5, `workerId` set); supplier rates the host site.

## PlatformSettings
Single row: dispatch windows and agency position, urgent threshold, minimum lead time, whether preferred partners get priority, platform fee %, currency, working-time limits (rest hours, weekly cap, max shift length), late-cancellation window.
