import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './audit.controller';

const router = Router();
const idParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });

router.use(requireAuth, requireCompany());

router.get(
  '/',
  requirePermission('audit.view'),
  validate({ query: ctrl.listQuerySchema }),
  ctrl.list,
);

router.get(
  '/:id',
  requirePermission('audit.view'),
  validate({ params: idParam }),
  ctrl.detail,
);

export default router;
