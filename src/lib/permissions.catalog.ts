/**
 * Operation-based permission catalog. Add to this list as new modules ship.
 * The seed script syncs this catalog into the `permissions` collection.
 *
 * Naming: `domain.action` (lowercase, snake_case for multi-word actions).
 */
export type RiskLevel = 'low' | 'medium' | 'high';

export interface PermissionDef {
  key: string;
  domain: string;
  action: string;
  description: string;
  riskLevel: RiskLevel;
}

const def = (
  key: string,
  description: string,
  riskLevel: RiskLevel = 'low',
): PermissionDef => {
  const [domain, ...rest] = key.split('.');
  return { key, domain, action: rest.join('.'), description, riskLevel };
};

export const PERMISSION_CATALOG: PermissionDef[] = [
  // Users
  def('users.view', 'View users in this company'),
  def('users.create', 'Create new users', 'medium'),
  def('users.update', 'Update user profile or status', 'medium'),
  def('users.deactivate', 'Deactivate a user', 'high'),
  def('users.reset_password', 'Trigger a password reset for any user', 'high'),

  // Roles
  def('roles.view', 'View roles defined in this company'),
  def('roles.create', 'Create new roles', 'medium'),
  def('roles.update', 'Edit a role and its permissions', 'medium'),
  def('roles.delete', 'Delete a non-system role', 'high'),

  // Permissions catalog
  def('permissions.view', 'View the master permission catalog'),

  // Companies
  def('companies.view', 'View company configuration'),
  def('companies.create', 'Create a new company tenant', 'high'),
  def('companies.update', 'Edit company configuration', 'medium'),
  def('companies.rotate_sap_creds', 'Rotate the SAP Service Layer credentials', 'high'),
  def('companies.deactivate', 'Deactivate a company tenant', 'high'),

  // Cross-company access management
  def('access.grant', 'Grant a user access to a company with a role', 'medium'),
  def('access.revoke', 'Revoke a user’s access to a company', 'high'),
  def('access.update', 'Update a user’s role assignments for a company', 'medium'),

  // Audit
  def('audit.view', 'View the master audit log'),
  def('audit.export', 'Export the audit log', 'medium'),

  // Records (SAP-mirrored read models — additional actions land as we layer them in)
  def('salesOrders.view', 'View sales orders synced from SAP'),
  def('invoices.view', 'View invoices synced from SAP'),
  def('payments.view', 'View payments synced from SAP'),
  def('creditNotes.view', 'View credit notes synced from SAP'),
  def('returns.view', 'View returns synced from SAP'),
  def('deliveryNotes.view', 'View delivery notes synced from SAP'),
  def(
    'deliveryNotes.convert',
    'Convert open delivery notes into SAP invoices (bulk push)',
    'high',
  ),

  // Daily payments — the "one sheet, every method" entry surface
  def('payments.create', 'Create or edit a payment entry (any method)', 'medium'),
  def(
    'payments.reconcile',
    'Reconcile a payment entry against an open invoice',
    'medium',
  ),
  def(
    'payments.push',
    'Push a reconciled payment to SAP (ORCT + RCT1/2/3/4)',
    'high',
  ),
  def('payments.void', 'Void a payment entry that has not been pushed', 'medium'),

  // Daily invoices — the "one sheet for the day" invoice surface
  def(
    'invoices.create',
    'Create an invoice manually (when not coming from a delivery note)',
    'high',
  ),
  def(
    'invoices.mark_unpaid',
    'Flag an invoice as a non-paid delivery (livraison non payée)',
    'medium',
  ),

  // SAP integration
  def('sap.sync', 'Trigger a SAP pull (delivery notes, invoices, payments, etc.)', 'medium'),
  def('sap.test', 'Test SAP login / verify credentials'),
  def('sap.view_state', 'View SAP sync state and history'),

  // Daybook (Feuille de solde) — monthly Excel ingestion
  def('daybook.view', 'View daybook files and parsed days'),
  def('daybook.upload', 'Upload a Feuille de solde workbook', 'medium'),
  def('daybook.delete', 'Delete a daybook file (and its parsed days)', 'high'),
  def('daybook.match', 'Reconcile LIVRAISONS cheques against SAP open invoices', 'medium'),
  def(
    'daybook.push',
    'Push matched LIVRAISONS cheques to SAP as Incoming Payments',
    'high',
  ),
  def('daybook.export', 'Download a Feuille de solde workbook regenerated from the data'),

  // Z-Report (POS daily verification)
  def('zreport.view', 'View Z-reports and per-day verification results'),
  def('zreport.upload', 'Upload a daily Z-report from the till', 'medium'),
  def('zreport.verify', 'Reconcile Z-report rows against SAP POS payments', 'medium'),

  // Bank statements (weekly reconciliation)
  def('bankStatement.view', 'View imported bank statements'),
  def('bankStatement.upload', 'Upload a bank statement (CSV/PDF)', 'medium'),
  def('bankStatement.match', 'Match bank lines against deposits / payments', 'medium'),

  // Card / PayPal payment imports
  def('payments.import.view', 'View Sogecommerce / PayPal imports'),
  def(
    'payments.import.upload',
    'Upload a Sogecommerce or PayPal export',
    'medium',
  ),
  def(
    'payments.import.match',
    'Assign a SAP customer to an imported payment row',
    'medium',
  ),

  // Item cost-history overlay
  def('itemCosts.view', 'View an item\'s app-managed cost history'),
  def(
    'itemCosts.upload',
    'Upload historical avg-cost overlays for items',
    'medium',
  ),
];

export const PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);

/** Default role: full operational read+write minus dangerous + admin operations. */
export const ACCOUNTANT_PERMISSION_KEYS: string[] = [
  'users.view',
  'roles.view',
  'permissions.view',
  'companies.view',
  'audit.view',
  'salesOrders.view',
  'invoices.view',
  'payments.view',
  'creditNotes.view',
  'returns.view',
  'deliveryNotes.view',
  'deliveryNotes.convert',
  'payments.create',
  'payments.reconcile',
  'payments.push',
  'payments.void',
  'invoices.create',
  'invoices.mark_unpaid',
  'sap.sync',
  'sap.test',
  'sap.view_state',
  'daybook.view',
  'daybook.upload',
  'daybook.match',
  'daybook.push',
  'daybook.export',
  'zreport.view',
  'zreport.upload',
  'zreport.verify',
  'bankStatement.view',
  'bankStatement.upload',
  'bankStatement.match',
  'payments.import.view',
  'payments.import.upload',
  'payments.import.match',
  'itemCosts.view',
  'itemCosts.upload',
];

/** Default role: everything in this catalog. */
export const OWNER_PERMISSION_KEYS: string[] = PERMISSION_KEYS.slice();
