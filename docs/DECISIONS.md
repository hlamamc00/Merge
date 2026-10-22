# Product decisions log

Decisions taken by the platform owner in response to the six-month simulation ([SIMULATION-REPORT.md](SIMULATION-REPORT.md)). Numbers refer to the list put to the owner on 2026-10-22; gap ids refer to the report's gap register.

| # | Gaps | Question | Decision | Status |
| --- | --- | --- | --- | --- |
| 1 | FIN-01, PF-04 | Who pays whom? | Hosts pay the platform; the platform pays suppliers. The platform carries the float and the credit risk. | Decided 2026-10-22 |
| 2 | PA-04 | Is the agency's own bank a supplier like any other? | No: own-bank supply is the agency's own sales (gross revenue, worker pay as cost of sales), not a supplier statement. No platform fee on bank shifts; margin reported separately. | Decided 2026-10-22 |
| 3 | PA-01 | Floor rates and uplifts | Platform-wide floor rates. The floor charge rate must cover at least the minimum wage payable to the worker plus the platform fee. Enforced (a shift cannot be posted below the floor). | Decided 2026-10-22. Open point: whether the floor should also cover employer on-costs (National Insurance, pension, holiday pay) so a supplier is not paid less than it costs to employ the worker. |
| 4 | TRS-01 | Penalties for late cancellations and no-shows | Not yet decided. | Open |
| 5 | PF-03 | Clocked or scheduled time? | Hosts pay clocked time. | Decided 2026-10-22. Open point: who may raise a credit against a statement, and rounding/overtime thresholds. |
| 6 | DSP-01 | Automatic escalation of unfilled shifts | Each host chooses automatic or manual escalation; automatic uses a host-set rate ceiling and widening steps. | Decided 2026-10-22 |
| 7 | PS-01 | How long an unanswered request holds a worker | Explanation requested. | Awaiting decision |
| 8 | WF-03 | Assume full contracted hours unless told otherwise | Yes. | Decided 2026-10-22 |
| 9 | WF-01 | Do verified documents and ratings follow a worker to a new employer (with consent)? | Yes. | Decided 2026-10-22 |
| 10 | ONB-03, PH-01, PH-03 | One organisation with site-scoped managers, or parent and child organisations? | Explanation requested. | Awaiting decision |
| 11 | PR-02 | Compliance evidence that may cross organisations | Each employer is responsible for ensuring its workers meet the standard mandatory requirements for care workers; hosts see a "meets mandatory requirements" status, not document details. Anything beyond the standard (specific training such as PEG feeding) is stated on the platform by the host, and suppliers declare which workers hold it. | Decided 2026-10-22 |
| 12 | PT-01 | Checks before a new organisation joins | Must be a legitimate care company (CQC registration or equivalent, checked at approval) and must agree to the memorandum of understanding (MOU) before approval. Registration creates a PENDING organisation; the platform admin approves. | Decided 2026-10-22 |
| 13 | SEC-01, PT-02 | Controller/processor stance; operator access to tenant data | The operator holds worker data to run the platform but does not need to see worker pay rates or DBS details; those stay with the employer (consistent with 11). | Decided 2026-10-22 for access. Open: whether the operator is a data controller or a processor (needs a legal view). |
| 14 | PC-01, PM-01, PM-02 | Safeguarding concerns about a lent worker | The worker is accountable to their employer. Under the MOU every employer must have a framework for handling reports about a lent worker from the host. The platform records a report and passes it to the employer; it does not mediate. Hosts can bar individual workers from their shifts. | Decided 2026-10-22 |
| 15 | COM-01, ONB-02 | Email and SMS providers; who pays for SMS | To be decided at deployment. Build against a provider-neutral channel interface. | Deferred |
| 16 | PT-03 | Two-factor authentication and single sign-on | Two-factor authentication is compulsory for admins and managers. | Decided 2026-10-22. Open: which sign-in providers (Microsoft assumed as the first). |
| 17 | PT-06 | Which rota systems to integrate first | Depends on what clients use; to be done after go-live. | Deferred |
| 18 | CMP-03 | Document storage and retention | | Open |
