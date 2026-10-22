import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';

/** compliance routes: filled in by the compliance build. */
export const complianceRouter = Router();
complianceRouter.use(requireAuth);
