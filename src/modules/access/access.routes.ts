import { Router } from 'express';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './access.controller';
import {
  grantAccessSchema,
  updateAccessSchema,
  revokeAccessSchema,
  listAccessQuerySchema,
  accessIdParam,
} from './access.validators';

const router = Router();

router.use(requireAuth, requireCompany());

router.get(
  '/',
  requirePermission('users.view'),
  validate({ query: listAccessQuerySchema }),
  ctrl.list,
);

router.post(
  '/',
  requirePermission('access.grant'),
  validate({ body: grantAccessSchema }),
  ctrl.grant,
);

router.patch(
  '/:id',
  requirePermission('access.update'),
  validate({ params: accessIdParam, body: updateAccessSchema }),
  ctrl.update,
);

router.post(
  '/:id/revoke',
  requirePermission('access.revoke'),
  validate({ params: accessIdParam, body: revokeAccessSchema }),
  ctrl.revoke,
);

export default router;
