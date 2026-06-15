import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './payments.controller';
import {
  createPaymentSchema,
  dateParamSchema,
  listQuerySchema,
  paymentIdParamSchema,
  pushPaymentSchema,
  reconcileSchema,
  updatePaymentSchema,
  voidPaymentSchema,
} from './payments.validators';

const router = Router();

const pushLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many SAP pushes' } },
});

router.use(requireAuth, requireCompany());

router.get(
  '/',
  requirePermission('payments.view'),
  validate({ query: listQuerySchema }),
  ctrl.list,
);

router.get(
  '/days/:date',
  requirePermission('payments.view'),
  validate({ params: dateParamSchema }),
  ctrl.getDayCtrl,
);

// Read-only — returns match candidates + scores for display. Performing a
// match goes through PUT /:id/match which keeps the write permission.
router.get(
  '/days/:date/reconciliation',
  requirePermission('payments.view'),
  validate({ params: dateParamSchema }),
  ctrl.reconciliation,
);

router.post(
  '/days/:date/auto-match',
  requirePermission('payments.reconcile'),
  validate({ params: dateParamSchema }),
  ctrl.autoMatch,
);

router.get(
  '/:id',
  requirePermission('payments.view'),
  validate({ params: paymentIdParamSchema }),
  ctrl.getOne,
);

router.post(
  '/',
  requirePermission('payments.create'),
  validate({ body: createPaymentSchema }),
  ctrl.create,
);

router.patch(
  '/:id',
  requirePermission('payments.create'),
  validate({ params: paymentIdParamSchema, body: updatePaymentSchema }),
  ctrl.update,
);

router.put(
  '/:id/match',
  requirePermission('payments.reconcile'),
  validate({ params: paymentIdParamSchema, body: reconcileSchema }),
  ctrl.reconcile,
);

router.post(
  '/:id/push',
  pushLimiter,
  requirePermission('payments.push'),
  validate({ params: paymentIdParamSchema, body: pushPaymentSchema }),
  ctrl.push,
);

router.post(
  '/:id/void',
  requirePermission('payments.void'),
  validate({ params: paymentIdParamSchema, body: voidPaymentSchema }),
  ctrl.voidCtrl,
);

export default router;
