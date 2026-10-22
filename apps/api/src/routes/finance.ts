import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';

/** finance routes: filled in by the finance build. */
export const financeRouter = Router();
financeRouter.use(requireAuth);
