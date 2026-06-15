import type { TenantModels } from '../models/tenant';
import type { SyncableEntity } from '../models/tenant/SapSyncState';

export interface EntityConfig {
  /** URL slug used in `POST /api/sap/sync/:slug`. */
  slug: string;
  /** Internal name (matches `SapSyncState.entity`). */
  entity: SyncableEntity;
  /** SAP B1 Service Layer collection path (no leading slash). */
  sapPath: string;
  /** Field on the SAP doc used as the upsert key. */
  idField: string;
  /** Field on the SAP doc used for date filtering (DocDate by default; UpdateDate for partners). */
  dateField: string;
  /** Key into `TenantModels` — i.e. which Mongoose model to upsert into. */
  modelKey: keyof TenantModels;
  /**
   * Extra `$filter` clauses always applied (e.g. `CardType eq 'cCustomer'`).
   * Combined with the date range using ` and `.
   */
  baseFilter?: string;
  /**
   * When true, the sync ignores any `from`/`to` window passed in the request
   * and pulls the full collection. Used for slow-changing master data like
   * Customers/BusinessPartners where chunking by date adds no value.
   */
  fullTable?: boolean;
}

export const ENTITY_CONFIGS: Record<string, EntityConfig> = {
  'delivery-notes': {
    slug: 'delivery-notes',
    entity: 'DeliveryNote',
    sapPath: 'DeliveryNotes',
    idField: 'DocEntry',
    dateField: 'DocDate',
    modelKey: 'DeliveryNote',
  },
  invoices: {
    slug: 'invoices',
    entity: 'Invoice',
    sapPath: 'Invoices',
    idField: 'DocEntry',
    dateField: 'DocDate',
    modelKey: 'Invoice',
  },
  payments: {
    slug: 'payments',
    entity: 'Payment',
    sapPath: 'IncomingPayments',
    idField: 'DocEntry',
    dateField: 'DocDate',
    modelKey: 'Payment',
  },
  'sales-orders': {
    slug: 'sales-orders',
    entity: 'SalesOrder',
    sapPath: 'Orders',
    idField: 'DocEntry',
    dateField: 'DocDate',
    modelKey: 'SalesOrder',
  },
  'credit-notes': {
    slug: 'credit-notes',
    entity: 'CreditNote',
    sapPath: 'CreditNotes',
    idField: 'DocEntry',
    dateField: 'DocDate',
    modelKey: 'CreditNote',
  },
  returns: {
    slug: 'returns',
    entity: 'Return',
    sapPath: 'Returns',
    idField: 'DocEntry',
    dateField: 'DocDate',
    modelKey: 'Return',
  },
  customers: {
    slug: 'customers',
    entity: 'Customer',
    sapPath: 'BusinessPartners',
    idField: 'CardCode',
    // dateField is unused while fullTable is true; kept here in case future
    // sync modes ever need an UpdateDate cursor.
    dateField: 'UpdateDate',
    modelKey: 'Customer',
    baseFilter: "CardType eq 'cCustomer'",
    fullTable: true,
  },
  items: {
    slug: 'items',
    entity: 'Item',
    sapPath: 'Items',
    idField: 'ItemCode',
    // Same as Customer — items are slow-changing master data, no DocDate to
    // window by. Cursor field is here only for future incremental modes.
    dateField: 'UpdateDate',
    modelKey: 'Item',
    fullTable: true,
  },
};

export const ENTITY_SLUGS = Object.keys(ENTITY_CONFIGS);

export function getEntityConfig(slug: string): EntityConfig | null {
  return ENTITY_CONFIGS[slug] ?? null;
}
