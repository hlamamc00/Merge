# Area C (organisation structure, compliance, security): integration notes

Everything below is a change needed in a file this build did not own. The owning build (or the parent)
should apply it; nothing here is required for Area C's own tests to pass.

## Must do before the sim or seed run

1. **Two-factor gate is on by default** (`platform_settings.two_factor_required_for_managers = true`, decision 16).
   Every ORG_ADMIN / ORG_MANAGER / PLATFORM_ADMIN request other than `GET /auth/me`, `/auth/2fa/*` and
   `/onboarding/change-password` returns `403 { details: { code: 'TWO_FACTOR_REQUIRED' } }` until the user enrols.
   - `apps/api/sim/*` and `src/db/seed.ts`: either switch the setting off right after bootstrap
     (`db.update(platformSettings).set({ twoFactorRequiredForManagers: false })`, as `test/api.test.ts` and
     `test/onboarding.test.ts` now do), or enrol the actors with `POST /auth/2fa/setup` + `/auth/2fa/enable`
     using `totpCode(secret, now)` from `src/lib/totp.ts`. For the demo seed, switching it off (and saying so in the
     README demo notes) is the sensible default; production keeps it on.
   - Any test file that creates managers and calls the API as them needs the same one-liner (finance.test.ts etc.).
2. **`mustChangePassword` gate**: a user with `must_change_password = 1` gets `403 { code: 'PASSWORD_CHANGE_REQUIRED' }`
   everywhere except the allow-list above. The onboarding build's invitation/import flows set the flag; its
   `POST /onboarding/change-password` must clear it (it does, per the current file). If that route moves, update
   `GATE_ALLOW_LIST` in `src/lib/auth.ts`.

## Shifts build (B)

- `POST /shifts` and `PATCH /shifts/:id` should call `assertSiteAccess(req, siteId)` (from `src/lib/auth.ts`) instead of
  only `assertOrgAccess`: a site-limited ORG_MANAGER (users.site_ids) must not post for another site.
- `GET /shifts?scope=posted` should filter `shifts.siteId` by `allowedSiteIds(req)` when it returns non-null.
- `services/eligibility.ts`: load documents with `isNull(workerDocuments.supersededAt)` (or pass them through
  `activeDocuments()` from `src/services/compliance.ts`). A verified document that has been corrected is kept as history
  with `superseded_at` set and must not count towards compliance; `GET /workers` and `GET /workers/:id` already exclude it.
- When a shift names `requiredHostRequirementIds`, the ids must belong to the host (`host_requirements.host_org_id`) and
  not be archived; `GET /compliance/requirements?hostOrgId=` is the list suppliers use to see what a host asks for.

## Onboarding build (A)

- `POST /onboarding/invitations` is called by WorkerDetailPage with `{ email, role: 'WORKER', workerId, firstName, lastName }`;
  the page falls back to `POST /workers/:id/login` (manager-set temporary password) when it gets a 404.
- Worker import: `homeSiteId` (or a `Home site` column resolved by site name) is now a worker field; importing it lets
  site-limited managers see their own people straight away. `consentToShare: true` is also accepted on `POST /workers`.
- The invitation email for managers could mention that they will be asked to set up an authenticator app on first sign-in.

## Layout / navigation (parent)

- `components/Layout.tsx`: the Compliance nav item is manager-only; the same route now renders "My documents" for
  WORKER logins (`/compliance`), so show it to workers too (label "My documents"). The worker dashboard links to it meanwhile.
- A link to `/setup-2fa` from the user menu would let a manager enrol voluntarily when the platform does not require it
  (Settings already has it).

## Web types (parent)

- `apps/web/src/api/types.ts`: `User` could gain `twoFactorEnabled`, `mustChangePassword`, `siteIds`, `phone`;
  `Organisation` the MOU/escalation fields; `WorkerDocument` the file fields; `Me` a `security` object. They are
  declared in `api/types.compliance.ts` for now and cast where used.

## Operational

- File storage: local disk by default (`FILE_STORAGE_DIR`, default `apps/api/data/files`, `data/files-test` under vitest).
  `S3Storage` is a stub that throws until the AWS SDK is wired in; `.env.example` documents the variables.
  Add `apps/api/data/` to backups; the documents are personal data and are never served without a session token
  (the browser fetches them with the bearer token and opens a blob URL).
- Decision 18 retention: superseded documents are kept; a purge job for `superseded_at < now - documentRetentionYears`
  is still to be written (belongs with the scheduler).
- QR code for authenticator enrolment: the set-up page shows the key and an `otpauth://` link; a QR image needs a small
  encoder (e.g. `qrcode` npm package) if wanted.
