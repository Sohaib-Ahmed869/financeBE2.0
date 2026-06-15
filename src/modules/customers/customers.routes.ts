import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './customers.controller';

const router = Router();

const cardCodeParamSchema = z.object({
  cardCode: z
    .string()
    .trim()
    .min(1, 'cardCode required')
    .max(64, 'cardCode too long'),
});

const searchQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
});

router.use(requireAuth, requireCompany());

router.get(
  '/',
  requirePermission('invoices.view'),
  validate({ query: searchQuerySchema }),
  ctrl.search,
);

router.get(
  '/:cardCode',
  requirePermission('invoices.view'),
  validate({ params: cardCodeParamSchema }),
  ctrl.lookup,
);

export default router;
