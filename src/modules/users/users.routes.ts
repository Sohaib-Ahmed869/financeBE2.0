import { Router } from 'express';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './users.controller';
import {
  createUserSchema,
  updateUserSchema,
  resetPasswordSchema,
  listUsersQuerySchema,
  objectIdSchema,
} from './users.validators';
import { z } from 'zod';

const router = Router();
const idParam = z.object({ id: objectIdSchema });

router.use(requireAuth, requireCompany());

router.get(
  '/',
  requirePermission('users.view'),
  validate({ query: listUsersQuerySchema }),
  ctrl.list,
);

router.post(
  '/',
  requirePermission('users.create'),
  validate({ body: createUserSchema }),
  ctrl.create,
);

router.get(
  '/:id',
  requirePermission('users.view'),
  validate({ params: idParam }),
  ctrl.get,
);

router.patch(
  '/:id',
  requirePermission('users.update'),
  validate({ params: idParam, body: updateUserSchema }),
  ctrl.update,
);

router.post(
  '/:id/deactivate',
  requirePermission('users.deactivate'),
  validate({ params: idParam }),
  ctrl.deactivate,
);

router.post(
  '/:id/reset-password',
  requirePermission('users.reset_password'),
  validate({ params: idParam, body: resetPasswordSchema }),
  ctrl.resetPassword,
);

export default router;
