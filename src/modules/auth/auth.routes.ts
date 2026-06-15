import { Router } from 'express';
import { validate } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import * as ctrl from './auth.controller';
import { loginSchema, updateMeSchema, changePasswordSchema } from './auth.validators';

const router = Router();

router.post('/login', authLimiter, validate({ body: loginSchema }), ctrl.login);
router.post('/logout', requireAuth, ctrl.logout);
router.get('/me', requireAuth, ctrl.me);
router.patch('/me', requireAuth, validate({ body: updateMeSchema }), ctrl.updateMe);
router.post(
  '/me/password',
  requireAuth,
  authLimiter,
  validate({ body: changePasswordSchema }),
  ctrl.changePassword,
);

export default router;
