import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';

/** trust routes: filled in by the trust build. */
export const trustRouter = Router();
trustRouter.use(requireAuth);
