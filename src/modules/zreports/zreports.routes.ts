import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './zreports.controller';

const router = Router();

const dateParam = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
});
const countedBody = z.object({
  countedCash: z.number().finite(),
});

router.use(requireAuth, requireCompany());

router.get('/', requirePermission('zreport.view'), ctrl.list);
router.get(
  '/:date',
  requirePermission('zreport.view'),
  validate({ params: dateParam }),
  ctrl.detail,
);
router.post('/upload', requirePermission('zreport.upload'), ctrl.uploadMiddleware, ctrl.upload_);
router.put(
  '/:date/counted-cash',
  requirePermission('zreport.verify'),
  validate({ params: dateParam, body: countedBody }),
  ctrl.counted,
);
router.post(
  '/:date/verify',
  requirePermission('zreport.verify'),
  validate({ params: dateParam }),
  ctrl.verify,
);

export default router;
