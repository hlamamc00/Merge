import cors from 'cors';
import express from 'express';
import type { Db } from './db/client.js';
import { config } from './config.js';
import type { AppDeps } from './lib/context.js';
import { errorMiddleware } from './lib/errors.js';
import { Notifier, consoleChannel, type NotificationChannel } from './lib/notify.js';
import { adminRouter } from './routes/admin.js';
import { complianceRouter } from './routes/compliance.js';
import { financeRouter } from './routes/finance.js';
import { onboardingRouter } from './routes/onboarding.js';
import { trustRouter } from './routes/trust.js';
import { assignmentsRouter } from './routes/assignments.js';
import { authRouter } from './routes/auth.js';
import { capacityRouter } from './routes/capacity.js';
import { invoicesRouter } from './routes/invoices.js';
import { notificationsRouter } from './routes/notifications.js';
import { organisationsRouter } from './routes/organisations.js';
import { reportsRouter } from './routes/reports.js';
import { shiftsRouter } from './routes/shifts.js';
import { timesheetsRouter } from './routes/timesheets.js';
import { workersRouter } from './routes/workers.js';
import { ensureSettings } from './services/settings.js';

export interface CreateAppOptions {
  db: Db;
  now?: () => Date;
  channels?: NotificationChannel[];
}

export function createApp(opts: CreateAppOptions) {
  const now = opts.now ?? (() => new Date());
  ensureSettings(opts.db, now());
  const deps: AppDeps = { db: opts.db, now, notifier: new Notifier(opts.db, opts.channels ?? (config.isTest ? [] : [consoleChannel]), now) };

  const app = express();
  app.locals.deps = deps;
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins, credentials: false }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: now().toISOString() }));
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/organisations', organisationsRouter);
  app.use('/api/v1/workers', workersRouter);
  app.use('/api/v1/capacity', capacityRouter);
  app.use('/api/v1/shifts', shiftsRouter);
  app.use('/api/v1/assignments', assignmentsRouter);
  app.use('/api/v1/timesheets', timesheetsRouter);
  app.use('/api/v1/invoices', invoicesRouter);
  app.use('/api/v1/notifications', notificationsRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/onboarding', onboardingRouter);
  app.use('/api/v1/trust', trustRouter);
  app.use('/api/v1/finance', financeRouter);
  app.use('/api/v1/compliance', complianceRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorMiddleware);
  return { app, deps };
}
