import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './deliveryNotes.controller';
import {
  listQuerySchema,
  docEntryParamSchema,
  bulkConvertSchema,
} from './deliveryNotes.validators';

const router = Router();

const convertLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many bulk conversions' } },
});

router.use(requireAuth, requireCompany());

router.get(
  '/',
  requirePermission('deliveryNotes.view'),
  validate({ query: listQuerySchema }),
  ctrl.list,
);

router.get(
  '/:docEntry',
  requirePermission('deliveryNotes.view'),
  validate({ params: docEntryParamSchema }),
  ctrl.detail,
);

router.post(
  '/bulk-convert',
  convertLimiter,
  requirePermission('deliveryNotes.convert'),
  validate({ body: bulkConvertSchema }),
  ctrl.bulkConvertCtrl,
);

export default router;
