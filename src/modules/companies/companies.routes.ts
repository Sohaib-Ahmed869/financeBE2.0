import { Router } from 'express';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './companies.controller';
import {
  createCompanySchema,
  updateCompanySchema,
  rotateSapSchema,
  keyParamSchema,
  updateOwnCompanyCardCodesSchema,
} from './companies.validators';

const router = Router();

// Companies management still happens *within* an active company context
// (so the audit log and permission resolution have a tenant). Super-admins
// can do this from any company they're switched into.
router.use(requireAuth, requireCompany());

router.get('/', requirePermission('companies.view'), ctrl.list);

router.post(
  '/',
  requirePermission('companies.create'),
  validate({ body: createCompanySchema }),
  ctrl.create,
);

router.get(
  '/:key',
  requirePermission('companies.view'),
  validate({ params: keyParamSchema }),
  ctrl.get,
);

router.patch(
  '/:key',
  requirePermission('companies.update'),
  validate({ params: keyParamSchema, body: updateCompanySchema }),
  ctrl.update,
);

router.post(
  '/:key/rotate-sap',
  requirePermission('companies.rotate_sap_creds'),
  validate({ params: keyParamSchema, body: rotateSapSchema }),
  ctrl.rotateSap,
);

router.post(
  '/:key/deactivate',
  requirePermission('companies.deactivate'),
  validate({ params: keyParamSchema }),
  ctrl.deactivate,
);

router.patch(
  '/:key/own-company-card-codes',
  requirePermission('companies.update'),
  validate({ params: keyParamSchema, body: updateOwnCompanyCardCodesSchema }),
  ctrl.updateOwnCompanyCardCodes,
);

export default router;
