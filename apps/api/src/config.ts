const DEV_JWT_SECRET = 'dev-only-secret-change-me';
const WEAK_SECRETS = new Set([DEV_JWT_SECRET, 'change-me-in-production', 'secret', 'password']);

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const production = process.env.NODE_ENV === 'production';
  if (production && (!secret || WEAK_SECRETS.has(secret) || secret.length < 32)) {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters when NODE_ENV=production');
  }
  return secret || DEV_JWT_SECRET;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? './data/merge.db',
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  schedulerIntervalSeconds: Number(process.env.SCHEDULER_INTERVAL_SECONDS ?? 60),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  isTest: process.env.NODE_ENV === 'test' || !!process.env.VITEST,
};
