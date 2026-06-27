import { Router } from 'express';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './reconciliation.controller';
import {
  discrepancyIdParamSchema,
  matchHistoricalSchema,
  monthParamSchema,
  resolveDiscrepancySchema,
  sapDocEntryParamSchema,
} from './reconciliation.validators';

const router = Router();
router.use(requireAuth, requireCompany());

router.get(
  '/month/:yearMonth',
  requirePermission('payments.view'),
  validate({ params: monthParamSchema }),
  ctrl.getMonth,
);

router.post(
  '/month/:yearMonth/seed',
  requirePermission('payments.reconcile'),
  validate({ params: monthParamSchema }),
  ctrl.seedMonth,
);

router.put(
  '/sap-payments/:sapDocEntry/match',
  requirePermission('payments.reconcile'),
  validate({ params: sapDocEntryParamSchema, body: matchHistoricalSchema }),
  ctrl.matchSapPayment,
);

router.post(
  '/discrepancies/:discrepancyId/resolve',
  requirePermission('payments.reconcile'),
  validate({ params: discrepancyIdParamSchema, body: resolveDiscrepancySchema }),
  ctrl.resolveDisc,
);

export default router;
