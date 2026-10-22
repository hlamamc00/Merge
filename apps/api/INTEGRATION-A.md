# Integration notes from build A (onboarding and communications)

Everything below touches files owned by other builds; apply after those builds finish.

## 1. Scheduler hooks (`src/services/scheduler.ts`)

```ts
import { drainOutbox, runDigest } from './delivery.js';

// inside tick(), after the existing jobs:
void drainOutbox(db, now);                       // sends due email/SMS through the channels chosen by env (SMTP_URL, MAIL_FROM); console otherwise
if (now.getUTCHours() === 7 && now.getUTCMinutes() < Math.max(1, intervalSeconds / 60)) runDigest(db, now);  // one digest per user per day
```

`tick()` is synchronous today; `drainOutbox` is async (SMTP), so call it with `void` and let it log its own failures. If you prefer the digest keyed off the date rather than the minute window, store the last run day in a module-level variable.

## 2. Password-change gate (web side only)

The API side is already done: `requireAuth` in `src/lib/auth.ts` answers `403 { details: { code: 'PASSWORD_CHANGE_REQUIRED' } }` on every gated route while `users.mustChangePassword` is set, and allows `POST /api/v1/onboarding/change-password` through. What is missing is the client reaction: in `apps/web/src/api/client.ts` (or the auth context), when a response carries that code, navigate to `/change-password` (page exists). Same pattern for `TWO_FACTOR_REQUIRED` → the two-factor set-up page from build C.

## 2b. Login page link (`apps/web/src/pages/LoginPage.tsx`, not owned by this build)

Add under the password field: `<Link to="/forgot-password">Forgotten your password?</Link>`. The page and API route exist; only the link is missing. `ResetPasswordPage` navigates to `/login` with `state.message` set after a successful reset, so LoginPage can show `location.state?.message` as a green banner if it wants to.

## 3. Worker detail page (build C): invite instead of typing a password

Replace the "Create login" call to `POST /workers/:id/login` with
`POST /api/v1/onboarding/invitations { email, role: 'WORKER', workerId, firstName, lastName }` (201 → `{ userId, email, role }`), and show "Invitation sent" with a "Resend" button calling `POST /api/v1/onboarding/invitations/resend { userId }`. Pending invitations for the organisation: `GET /api/v1/onboarding/invitations`.

## 4. Navigation (`Layout.tsx`, owned by the parent)

Add `{ to: '/workers/import', label: 'Import workers', icon: '⇪', show: isManager }` after the Workers item, and a "Notification settings" link wherever Settings lists per-user options (`/settings/notifications`).

## 5. Environment (`apps/api/.env.example`, owned by the parent)

```
# Where emailed links point (invitations, password resets).
WEB_URL=http://localhost:5173
# Leave unset to print emails to the console. Any SMTP endpoint works, e.g. smtps://user:pass@smtp.sendgrid.net:465
SMTP_URL=
MAIL_FROM=Merge <no-reply@example.com>
```

## 6. Test suites

`test/onboarding.test.ts` disables `twoFactorRequiredForManagers` directly in the database after `ensureSettings`, because its subject is onboarding, not 2FA. It does not touch `test/api.test.ts`. Both suites pass on the current tree (15 and 25 tests).
