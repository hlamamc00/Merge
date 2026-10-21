# Feature roadmap

What is built today is a complete, testable core: organisations, workers, compliance, capacity flags with priority dispatch, bookings, timesheets, statements, notifications, audit and admin. Below are the features I recommend adding to make Merge a comprehensive platform, grouped by theme and roughly ordered by value within each group. Items marked **★** are the ones I would do first.

## 1. Matching and dispatch

- **★ Shortage ↔ surplus proactive matching.** A `SHORTAGE` flag today is informational. Use it: when one is raised, show the host which organisations have matching surplus and let them post shifts straight to them; conversely notify surplus organisations that demand is building in their area so they keep flags current.
- **★ Availability blocks (the reverse marketplace).** Let a supplier publish *"Aisha is free Tue–Thu, days"* and let hosts book against that, not only the other way round. Capacity flags become bookable inventory.
- **★ Block bookings and runs.** Book the same worker for a run of shifts (continuity of care matters to residents and reduces induction overhead); post recurring shift patterns and rota packs in one go.
- **Fairness controls.** Round-robin within the priority tier, caps on the share of a host's shifts any one supplier can take, and a configurable weighting that nudges priority by reliability score, not only by flag age.
- **Rate cards and dynamic pricing.** Per-role / night / weekend / bank-holiday uplifts, a host's maximum rate, auto-uplift when a shift is still unfilled at T-24 h, and supplier counter-offers.
- **Escalation playbooks.** Per-host rules such as "if unfilled 24 h before start: widen to network, raise rate 10 %, include agency bank, send SMS blast".
- **Favourites and "request again".** Hosts keep a list of workers who know their residents; those workers are suggested first and can be offered directly before general release (an extension of the direct-offer feature already built).
- **Internal-first within a group.** For provider groups with several homes, run an internal float-pool stage before the external exchange.
- **Real geocoding and travel time.** Postcode lookup (e.g. postcodes.io for the UK), travel-time rather than straight-line distance, and public-transport awareness for workers without a car.

## 2. Compliance and governance (care-sector specific)

- **★ Document storage and verification.** Upload files to object storage, virus-scan, OCR the expiry date, and show the file to verifiers. Add checks against the DBS Update Service, the NMC register and Home Office right-to-work share codes where APIs or manual workflows allow.
- **★ Site induction and host-specific requirements.** Record that a worker has completed a site's induction / orientation and read its key policies; hosts can require it for any shift (first shift triggers an induction task).
- **Training matrix integration.** Pull certificates from e-learning providers and map them to the platform's document types; configurable required-document sets per host (some require extra training for specialist units).
- **Incident and safeguarding reporting** linked to a shift and worker, with a "do not return" marker per site and a mediation workflow run by the platform.
- **Regulatory records.** CQC-ready exports of who worked where with which checks; AWR (12-week parity) tracking for repeat placements; WTR opt-out documents stored against the worker; GDPR tooling (data-sharing consent per worker, retention policies, subject-access exports).
- **Insurance and registration checks per organisation** (employer's liability, CQC registration status) with expiry reminders, gating participation.

## 3. Worker experience

- **★ Mobile app or PWA** with push notifications, one-tap shift pick-up, GPS/geofenced clock-in, directions, digital access notes, and the ability to upload their own documents for the employer to verify.
- **Worker preferences:** no nights, max travel, preferred sites, minimum notice; preferences feed eligibility as warnings.
- **Shift reminders** (24 h and 2 h) by SMS/push, handover notes from the previous shift, mileage and expense claims.
- **Fatigue and wellbeing checks:** consecutive-nights limits, declared hours with other employers so the 48 h average is real, wellbeing nudges after long runs.
- **Worker-to-worker swaps** within the same supplier for confirmed bookings, subject to re-running eligibility.

## 4. Finance

- **★ Self-billing and payment collection.** Weekly or monthly cycles, self-billing invoices on behalf of suppliers, VAT treatment, Direct Debit / card collection (e.g. GoCardless, Stripe), supplier payouts, credit control and late-payment alerts.
- **★ Accounting exports:** Xero, QuickBooks, Sage; payroll exports for suppliers (hours per worker per period).
- **Cancellation and no-show fees** per the platform's terms (late-cancellation is already tracked), credit notes and adjustments on statements.
- **Platform pricing models:** percentage fee (built), per-shift fee, subscription tiers, and agency-margin reporting for the agency's own bank.
- **Budget controls for hosts:** monthly spend caps, approval steps above a rate threshold, cost-centre tagging per site.

## 5. Communication and operations

- **★ Notification channels:** email (SendGrid/SES), SMS/WhatsApp (Twilio), push; per-user preferences and quiet hours. The API already has a `NotificationChannel` interface to plug these in.
- **In-app messaging** per shift between host, supplier and worker, with site packs (fire procedure, floor plan, parking).
- **Rota system integrations** (e.g. RotaCloud, Access, PCS, CarePlanner): import gaps as draft shifts, push confirmed bookings back; iCal feeds; a public API with keys and webhooks.
- **Bulk tools:** CSV import of workers and documents, bulk shift creation, templates.

## 6. Trust and quality

- **★ Reliability scores** from on-time clock-ins, late cancellations and no-shows, visible to hosts and used by dispatch; host site scores from worker ratings (safety, support, accuracy of shift description).
- **Verified badges:** "worked here before", "induction complete", agency-vetted; photo ID badge with QR for on-site verification.
- **Dispute resolution** workflow with evidence, platform mediation and outcomes feeding scores.

## 7. Analytics and forecasting

- **Supply/demand heatmaps** by area, role and time of day; fill rate, time-to-fill, cost versus agency benchmark; weekly digests.
- **Capacity forecasting** from occupancy, seasonality and leave calendars, prompting organisations to flag surplus or shortage *before* it bites.
- **Fairness and flow reporting** for the agency: hours placed via priority access versus the open network, by organisation.

## 8. Platform and multi-tenancy

- **Organisation groups** (a parent company with many homes) with group-level admins and internal-first dispatch; **regions** for multi-area agencies; **white-label** so several agencies can run their own networks on one deployment.
- **Identity:** email invitations, password reset, MFA for admins, SSO (Microsoft Entra / Google), fine-grained permissions.
- **Operational hardening:** Postgres, a queue for notifications and scheduler jobs, object storage, observability, backups and restore drills, rate limiting, security review.

## Points to confirm with advisers

Merge effectively supplies workers between employers, so the operating company should confirm with legal and tax advisers how the Conduct of Employment Agencies and Employment Businesses Regulations, the Agency Workers Regulations, VAT on staff supplies, employer's liability insurance per organisation, and data-processing agreements between organisations apply to the chosen operating model. The platform records the data these frameworks need, but the policy decisions are the operator's.
