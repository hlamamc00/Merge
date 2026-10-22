import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';

/** onboarding routes: filled in by the onboarding build. */
export const onboardingRouter = Router();
onboardingRouter.use(requireAuth);
