export const config = {
  databaseUrl: process.env.DATABASE_URL ?? './data/merge.db',
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  schedulerIntervalSeconds: Number(process.env.SCHEDULER_INTERVAL_SECONDS ?? 60),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  isTest: process.env.NODE_ENV === 'test' || !!process.env.VITEST,
};
