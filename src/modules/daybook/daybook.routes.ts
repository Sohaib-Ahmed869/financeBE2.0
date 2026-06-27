import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './daybook.controller';
import {
  dayParamSchema,
  upsertDaySchema,
  setMatchSchema,
  lineIndexParamSchema,
  pushDaySchema,
  pushPosExtrasSchema,
} from './daybook.validators';
import {
  reconcileSchema as importedReconcileSchema,
  pushPaymentSchema as importedPushSchema,
} from '../payments/payments.validators';

const router = Router();

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many uploads' } },
});

const fileIdParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id') });
const dateParam = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
});

router.use(requireAuth, requireCompany());

const yearMonthParam = z.object({
  year: z.string().regex(/^\d{4}$/, 'Bad year'),
  month: z.string().regex(/^(0?[1-9]|1[0-2])$/, 'Bad month'),
});

router.get('/files', requirePermission('daybook.view'), ctrl.list);
router.get('/months', requirePermission('daybook.view'), ctrl.months);
router.get(
  '/kpis/:year/:month',
  requirePermission('daybook.view'),
  validate({ params: yearMonthParam }),
  ctrl.kpis,
);
router.get(
  '/failed-pushes',
  requirePermission('daybook.push'),
  ctrl.failedPushes,
);
router.post(
  '/failed-pushes/retry',
  requirePermission('daybook.push'),
  ctrl.retryFailedPushesCtrl,
);
router.get(
  '/months/:year/:month',
  requirePermission('daybook.view'),
  validate({ params: yearMonthParam }),
  ctrl.getMonth,
);
router.get(
  '/months/:year/:month/export',
  requirePermission('daybook.export'),
  validate({ params: yearMonthParam }),
  ctrl.exportMonth,
);
router.get(
  '/files/:id',
  requirePermission('daybook.view'),
  validate({ params: fileIdParam }),
  ctrl.getOne,
);
router.get(
  '/days/:date',
  requirePermission('daybook.view'),
  validate({ params: dateParam }),
  ctrl.getDay,
);

router.post(
  '/upload',
  uploadLimiter,
  requirePermission('daybook.upload'),
  ctrl.uploadMiddleware,
  ctrl.upload_,
);

router.put(
  '/days/:date',
  requirePermission('daybook.upload'),
  validate({ params: dayParamSchema, body: upsertDaySchema }),
  ctrl.upsertDay,
);

router.get(
  '/days/:date/reconciliation',
  requirePermission('daybook.match'),
  validate({ params: dayParamSchema }),
  ctrl.reconciliation,
);

router.post(
  '/days/:date/sync-sap',
  requirePermission('daybook.match'),
  validate({ params: dayParamSchema }),
  ctrl.syncSap,
);

router.get(
  '/days/:date/discrepancy',
  requirePermission('daybook.match'),
  validate({ params: dayParamSchema }),
  ctrl.discrepancy,
);

router.post(
  '/days/:date/auto-match',
  requirePermission('daybook.match'),
  validate({ params: dayParamSchema }),
  ctrl.autoMatch,
);

router.put(
  '/days/:date/livraisons/:index/match',
  requirePermission('daybook.match'),
  validate({ params: lineIndexParamSchema, body: setMatchSchema }),
  ctrl.setMatch,
);

// Imported card / PayPal payments — match & push reuse the payments pipeline
// but are guarded by daybook permissions so the daybook stays self-contained.
router.post(
  '/days/:date/imported/auto-match',
  requirePermission('daybook.match'),
  validate({ params: dateParam }),
  ctrl.importedAutoMatch,
);

router.put(
  '/imported/:id/match',
  requirePermission('daybook.match'),
  validate({ params: fileIdParam, body: importedReconcileSchema }),
  ctrl.matchImported,
);

router.post(
  '/imported/:id/push',
  requirePermission('daybook.push'),
  validate({ params: fileIdParam, body: importedPushSchema }),
  ctrl.pushImported,
);

router.post(
  '/days/:date/push',
  requirePermission('daybook.push'),
  validate({ params: dayParamSchema, body: pushDaySchema }),
  ctrl.push,
);

router.post(
  '/days/:date/push-pos-extras',
  requirePermission('daybook.push'),
  validate({ params: dayParamSchema, body: pushPosExtrasSchema }),
  ctrl.pushPosExtrasCtrl,
);

router.delete(
  '/files/:id',
  requirePermission('daybook.delete'),
  validate({ params: fileIdParam }),
  ctrl.remove,
);

export default router;
