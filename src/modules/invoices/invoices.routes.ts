import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './invoices.controller';
import {
  createInvoiceSchema,
  dateParamSchema,
  docEntryParamSchema,
  listQuerySchema,
  markUnpaidSchema,
} from './invoices.validators';

const router = Router();

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many invoice creations' } },
});

router.use(requireAuth, requireCompany());

router.get(
  '/',
  requirePermission('invoices.view'),
  validate({ query: listQuerySchema }),
  ctrl.list,
);

router.get(
  '/days/:date',
  requirePermission('invoices.view'),
  validate({ params: dateParamSchema }),
  ctrl.getDayCtrl,
);

router.get(
  '/:docEntry',
  requirePermission('invoices.view'),
  validate({ params: docEntryParamSchema }),
  ctrl.detail,
);

router.post(
  '/',
  createLimiter,
  requirePermission('invoices.create'),
  validate({ body: createInvoiceSchema }),
  ctrl.create,
);

router.patch(
  '/:docEntry/unpaid-flag',
  requirePermission('invoices.mark_unpaid'),
  validate({ params: docEntryParamSchema, body: markUnpaidSchema }),
  ctrl.markUnpaid,
);

export default router;
