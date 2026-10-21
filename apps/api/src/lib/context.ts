import type { Request } from 'express';
import type { Db } from '../db/client.js';
import type { Organisation, PlatformSettingsRow, User } from '../db/schema.js';
import type { Notifier } from './notify.js';

/** Everything a request handler needs that is not in the request itself. */
export interface AppDeps {
  db: Db;
  notifier: Notifier;
  /** Injectable clock so tests can move time forward through dispatch stages. */
  now: () => Date;
}

export interface AuthContext {
  user: User;
  org: Organisation;
  settings: PlatformSettingsRow;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export function deps(req: Request): AppDeps {
  return req.app.locals.deps as AppDeps;
}

export function auth(req: Request): AuthContext {
  if (!req.auth) throw new Error('auth() called on an unauthenticated request');
  return req.auth;
}
