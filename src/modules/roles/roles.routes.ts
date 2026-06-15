import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './roles.controller';
import {
  createRoleSchema,
  updateRoleSchema,
  listRolesQuerySchema,
  objectIdSchema,
} from './roles.validators';

const router = Router();
const idParam = z.object({ id: objectIdSchema });

router.use(requireAuth, requireCompany());

router.get(
  '/',
  requirePermission('roles.view'),
  validate({ query: listRolesQuerySchema }),
  ctrl.list,
);

router.post(
  '/',
  requirePermission('roles.create'),
  validate({ body: createRoleSchema }),
  ctrl.create,
);

router.get('/:id', requirePermission('roles.view'), validate({ params: idParam }), ctrl.get);

router.patch(
  '/:id',
  requirePermission('roles.update'),
  validate({ params: idParam, body: updateRoleSchema }),
  ctrl.update,
);

router.delete(
  '/:id',
  requirePermission('roles.delete'),
  validate({ params: idParam }),
  ctrl.remove,
);

export default router;
