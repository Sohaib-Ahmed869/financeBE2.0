import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './itemCosts.controller';

const router = Router();
router.use(requireAuth, requireCompany());

const itemCodeParam = z.object({ itemCode: z.string().min(1).max(64) });

router.post(
  '/upload',
  requirePermission('itemCosts.upload'),
  ctrl.uploadMiddleware,
  ctrl.upload_,
);
router.get(
  '/:itemCode',
  requirePermission('itemCosts.view'),
  validate({ params: itemCodeParam }),
  ctrl.history,
);

export default router;
