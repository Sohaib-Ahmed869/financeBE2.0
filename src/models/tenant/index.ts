import type { Connection, Model } from 'mongoose';

// SAP read-models
import { CustomerSchema, type ICustomer } from './Customer';
import { ItemSchema, type IItem } from './Item';
import { InvoiceSchema, type IInvoice } from './Invoice';
import { SalesOrderSchema, type ISalesOrder } from './SalesOrder';
import { DeliveryNoteSchema, type IDeliveryNote } from './DeliveryNote';
import { CreditNoteSchema, type ICreditNote } from './CreditNote';
import { ReturnSchema, type IReturn } from './Return';
import { PaymentSchema, type IPayment } from './Payment';

// Operational
import { PaymentEntrySchema, type IPaymentEntry } from './PaymentEntry';
import { PaymentMatchSchema, type IPaymentMatch } from './PaymentMatch';
import { ZReportSchema, type IZReport } from './ZReport';
import { BankStatementSchema, type IBankStatement } from './BankStatement';
import { BankStatementLineSchema, type IBankStatementLine } from './BankStatementLine';
import { ImportFileSchema, type IImportFile } from './ImportFile';
import { ImportRowSchema, type IImportRow } from './ImportRow';
import { DiscrepancySchema, type IDiscrepancy } from './Discrepancy';
import { ResolutionSchema, type IResolution } from './Resolution';
import { MatchingRuleSchema, type IMatchingRule } from './MatchingRule';
import { LearnedPatternSchema, type ILearnedPattern } from './LearnedPattern';
import { PeriodCloseSchema, type IPeriodClose } from './PeriodClose';
import { TagSchema, type ITag } from './Tag';
import { DocumentSchema, type IDocument } from './Document';
import { SapSyncStateSchema, type ISapSyncState } from './SapSyncState';
import { SyncJobSchema, type ISyncJob } from './SyncJob';
import { AuditTenantSchema, type IAuditTenant } from './AuditTenant';
import { DaybookFileSchema, type IDaybookFile } from './DaybookFile';
import { DaybookDaySchema, type IDaybookDay } from './DaybookDay';

export interface TenantModels {
  // SAP read-models
  Customer: Model<ICustomer>;
  Item: Model<IItem>;
  Invoice: Model<IInvoice>;
  SalesOrder: Model<ISalesOrder>;
  DeliveryNote: Model<IDeliveryNote>;
  CreditNote: Model<ICreditNote>;
  Return: Model<IReturn>;
  Payment: Model<IPayment>;

  // Operational
  PaymentEntry: Model<IPaymentEntry>;
  PaymentMatch: Model<IPaymentMatch>;
  ZReport: Model<IZReport>;
  BankStatement: Model<IBankStatement>;
  BankStatementLine: Model<IBankStatementLine>;
  ImportFile: Model<IImportFile>;
  ImportRow: Model<IImportRow>;
  Discrepancy: Model<IDiscrepancy>;
  Resolution: Model<IResolution>;
  MatchingRule: Model<IMatchingRule>;
  LearnedPattern: Model<ILearnedPattern>;
  PeriodClose: Model<IPeriodClose>;
  Tag: Model<ITag>;
  Document: Model<IDocument>;
  SapSyncState: Model<ISapSyncState>;
  SyncJob: Model<ISyncJob>;
  AuditTenant: Model<IAuditTenant>;
  DaybookFile: Model<IDaybookFile>;
  DaybookDay: Model<IDaybookDay>;
}

const cache = new WeakMap<Connection, TenantModels>();

/**
 * Returns the per-tenant models bound to a specific Mongoose connection.
 *
 * IMPORTANT: never use the default `mongoose.model('Foo', schema)` for tenant
 * data — that would register against the master connection and leak across
 * companies. Always go through this helper, which uses
 * `connection.model(...)` so the model lives on that exact connection only.
 */
export function getTenantModels(conn: Connection): TenantModels {
  const cached = cache.get(conn);
  if (cached) return cached;

  const models: TenantModels = {
    // SAP read-models
    Customer: conn.model<ICustomer>('Customer', CustomerSchema, 'customers'),
    Item: conn.model<IItem>('Item', ItemSchema, 'items'),
    Invoice: conn.model<IInvoice>('Invoice', InvoiceSchema, 'invoices'),
    SalesOrder: conn.model<ISalesOrder>('SalesOrder', SalesOrderSchema, 'sales_orders'),
    DeliveryNote: conn.model<IDeliveryNote>('DeliveryNote', DeliveryNoteSchema, 'delivery_notes'),
    CreditNote: conn.model<ICreditNote>('CreditNote', CreditNoteSchema, 'credit_notes'),
    Return: conn.model<IReturn>('Return', ReturnSchema, 'returns'),
    Payment: conn.model<IPayment>('Payment', PaymentSchema, 'payments'),

    // Operational
    PaymentEntry: conn.model<IPaymentEntry>(
      'PaymentEntry',
      PaymentEntrySchema,
      'payment_entries',
    ),
    PaymentMatch: conn.model<IPaymentMatch>(
      'PaymentMatch',
      PaymentMatchSchema,
      'payment_matches',
    ),
    ZReport: conn.model<IZReport>('ZReport', ZReportSchema, 'zreports'),
    BankStatement: conn.model<IBankStatement>(
      'BankStatement',
      BankStatementSchema,
      'bank_statements',
    ),
    BankStatementLine: conn.model<IBankStatementLine>(
      'BankStatementLine',
      BankStatementLineSchema,
      'bank_statement_lines',
    ),
    ImportFile: conn.model<IImportFile>('ImportFile', ImportFileSchema, 'import_files'),
    ImportRow: conn.model<IImportRow>('ImportRow', ImportRowSchema, 'import_rows'),
    Discrepancy: conn.model<IDiscrepancy>('Discrepancy', DiscrepancySchema, 'discrepancies'),
    Resolution: conn.model<IResolution>('Resolution', ResolutionSchema, 'resolutions'),
    MatchingRule: conn.model<IMatchingRule>('MatchingRule', MatchingRuleSchema, 'matching_rules'),
    LearnedPattern: conn.model<ILearnedPattern>(
      'LearnedPattern',
      LearnedPatternSchema,
      'learned_patterns',
    ),
    PeriodClose: conn.model<IPeriodClose>('PeriodClose', PeriodCloseSchema, 'period_close'),
    Tag: conn.model<ITag>('Tag', TagSchema, 'tags'),
    Document: conn.model<IDocument>('Document', DocumentSchema, 'documents'),
    SapSyncState: conn.model<ISapSyncState>('SapSyncState', SapSyncStateSchema, 'sap_sync_state'),
    SyncJob: conn.model<ISyncJob>('SyncJob', SyncJobSchema, 'sync_jobs'),
    AuditTenant: conn.model<IAuditTenant>('AuditTenant', AuditTenantSchema, 'audit_tenant'),
    DaybookFile: conn.model<IDaybookFile>('DaybookFile', DaybookFileSchema, 'daybook_files'),
    DaybookDay: conn.model<IDaybookDay>('DaybookDay', DaybookDaySchema, 'daybook_days'),
  };
  cache.set(conn, models);
  return models;
}

export type {
  ICustomer,
  IItem,
  IInvoice,
  ISalesOrder,
  IDeliveryNote,
  ICreditNote,
  IReturn,
  IPayment,
  IPaymentEntry,
  IPaymentMatch,
  IZReport,
  IBankStatement,
  IBankStatementLine,
  IImportFile,
  IImportRow,
  IDiscrepancy,
  IResolution,
  IMatchingRule,
  ILearnedPattern,
  IPeriodClose,
  ITag,
  IDocument,
  ISapSyncState,
  ISyncJob,
  IAuditTenant,
  IDaybookFile,
  IDaybookDay,
};
