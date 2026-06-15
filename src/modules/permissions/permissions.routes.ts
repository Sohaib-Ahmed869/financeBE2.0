import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requireCompany } from '../../middleware/tenant';
import { requirePermission } from '../../middleware/rbac';
import * as ctrl from './permissions.controller';

const router = Router();

router.use(requireAuth, requireCompany());
router.get('/', requirePermission('permissions.view'), ctrl.list);

export default router;
