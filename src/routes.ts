import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes';
import usersRoutes from './modules/users/users.routes';
import rolesRoutes from './modules/roles/roles.routes';
import permissionsRoutes from './modules/permissions/permissions.routes';
import companiesRoutes from './modules/companies/companies.routes';
import accessRoutes from './modules/access/access.routes';
import auditRoutes from './modules/audit/audit.routes';
import sapRoutes from './modules/sap/sap.routes';
import daybookRoutes from './modules/daybook/daybook.routes';
import deliveryNotesRoutes from './modules/deliveryNotes/deliveryNotes.routes';
import paymentsRoutes from './modules/payments/payments.routes';
import invoicesRoutes from './modules/invoices/invoices.routes';
import zreportsRoutes from './modules/zreports/zreports.routes';
import bankStatementsRoutes from './modules/bankStatements/bankStatements.routes';
import cardImportsRoutes from './modules/cardImports/cardImports.routes';
import itemCostsRoutes from './modules/itemCosts/itemCosts.routes';
import customersRoutes from './modules/customers/customers.routes';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/roles', rolesRoutes);
router.use('/permissions', permissionsRoutes);
router.use('/companies', companiesRoutes);
router.use('/access', accessRoutes);
router.use('/audit', auditRoutes);
router.use('/sap', sapRoutes);
router.use('/daybook', daybookRoutes);
router.use('/delivery-notes', deliveryNotesRoutes);
router.use('/payments', paymentsRoutes);
router.use('/invoices', invoicesRoutes);
router.use('/zreports', zreportsRoutes);
router.use('/bank-statements', bankStatementsRoutes);
router.use('/card-imports', cardImportsRoutes);
router.use('/item-costs', itemCostsRoutes);
router.use('/customers', customersRoutes);

export default router;
