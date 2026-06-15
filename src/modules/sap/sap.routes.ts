import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './sap.controller';
import {
  entityParamSchema,
  syncBodySchema,
  jobIdParamSchema,
  listJobsQuerySchema,
} from './sap.validators';

const router = Router();

// Trigger a sync — rate-limited because it's expensive.
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many SAP sync triggers' } },
});

router.use(requireAuth, requireCompany());

// Discovery / state — cheap, unlimited
router.get('/entities', requirePermission('sap.view_state'), ctrl.entities);
router.get('/sync-state', requirePermission('sap.view_state'), ctrl.syncState);
router.get('/runner-stats', requirePermission('sap.view_state'), ctrl.runnerStats);

// Test login
router.post('/test', requirePermission('sap.test'), ctrl.test);

// Trigger a sync (returns 202 + jobId by default; pass {wait:true} for inline)
router.post(
  '/sync/:entity',
  syncLimiter,
  requirePermission('sap.sync'),
  validate({ params: entityParamSchema, body: syncBodySchema }),
  ctrl.sync,
);

// Job management
router.get(
  '/jobs',
  requirePermission('sap.view_state'),
  validate({ query: listJobsQuerySchema }),
  ctrl.listJobs,
);
router.get(
  '/jobs/:id',
  requirePermission('sap.view_state'),
  validate({ params: jobIdParamSchema }),
  ctrl.getJob,
);
router.post(
  '/jobs/:id/cancel',
  requirePermission('sap.sync'),
  validate({ params: jobIdParamSchema }),
  ctrl.cancelJob,
);

export default router;
