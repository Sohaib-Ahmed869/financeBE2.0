import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './cardImports.controller';

const router = Router();

router.use(requireAuth, requireCompany());

const idParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });
const rowIdParam = z.object({ rowId: z.string().regex(/^[a-f0-9]{24}$/i) });

router.get('/', requirePermission('payments.import.view'), ctrl.list);
router.get(
  '/:id',
  requirePermission('payments.import.view'),
  validate({ params: idParam }),
  ctrl.detail,
);
router.post(
  '/upload',
  requirePermission('payments.import.upload'),
  ctrl.uploadMiddleware,
  ctrl.upload_,
);
router.post(
  '/upload-remises',
  requirePermission('payments.import.upload'),
  ctrl.uploadMiddleware,
  ctrl.uploadRemises,
);
router.put(
  '/rows/:rowId/assign',
  requirePermission('payments.import.match'),
  validate({ params: rowIdParam, body: ctrl.assignBodySchema }),
  ctrl.assign,
);

export default router;
