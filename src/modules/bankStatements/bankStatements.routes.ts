import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './bankStatements.controller';

const router = Router();

const idParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id') });
const tagBody = z.object({
  status: z.enum(['unmatched', 'matched', 'tagged', 'ignored', 'flagged']).optional(),
  category: z
    .enum([
      'unknown',
      'pos-deposit',
      'cash-deposit',
      'card-settlement',
      'sogecommerce',
      'paypal',
      'sepa-credit',
      'sepa-debit',
      'fee',
      'expense',
      'transfer-internal',
      'other',
    ])
    .optional(),
  tags: z.array(z.string().trim()).optional(),
  notes: z.string().max(500).optional(),
  /** SAP CardCode the user assigned to this line. Triggers counterparty learning. */
  matchedCardCode: z.string().trim().max(64).optional(),
});

router.use(requireAuth, requireCompany());

router.get('/', requirePermission('bankStatement.view'), ctrl.list);
router.get(
  '/:id',
  requirePermission('bankStatement.view'),
  validate({ params: idParam }),
  ctrl.detail,
);
router.post(
  '/upload',
  requirePermission('bankStatement.upload'),
  ctrl.uploadMiddleware,
  ctrl.upload_,
);
router.post(
  '/:id/auto-match',
  requirePermission('bankStatement.match'),
  validate({ params: idParam }),
  ctrl.autoMatch,
);
router.put(
  '/lines/:id',
  requirePermission('bankStatement.match'),
  validate({ params: idParam, body: tagBody }),
  ctrl.tag,
);

export default router;
