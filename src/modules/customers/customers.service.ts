import { getTenantModelsFor } from '../../db/tenant';
import { NotFoundError } from '../../lib/errors';

export interface CustomerLookupDTO {
  CardCode: string;
  CardName: string;
  EmailAddress: string | null;
  Phone1: string | null;
  CurrentAccountBalance: number;
  Frozen: string | null;
}

const projection = {
  CardCode: 1,
  CardName: 1,
  EmailAddress: 1,
  Phone1: 1,
  CurrentAccountBalance: 1,
  Frozen: 1,
} as const;

function toDTO(raw: Record<string, unknown>): CustomerLookupDTO {
  return {
    CardCode: String(raw.CardCode ?? ''),
    CardName: String(raw.CardName ?? ''),
    EmailAddress: (raw.EmailAddress as string | null | undefined) ?? null,
    Phone1: (raw.Phone1 as string | null | undefined) ?? null,
    CurrentAccountBalance: Number(raw.CurrentAccountBalance ?? 0),
    Frozen: (raw.Frozen as string | null | undefined) ?? null,
  };
}

/**
 * Single-customer lookup by exact CardCode. CardCodes in SAP are upper-case;
 * we normalize the input so the FE can be lazy about casing.
 */
export async function getCustomerByCardCode(
  companyKey: string,
  cardCode: string,
): Promise<CustomerLookupDTO> {
  const models = await getTenantModelsFor(companyKey);
  const doc = await models.Customer.findOne(
    { CardCode: cardCode.toUpperCase() },
    projection,
  ).lean();
  if (!doc) throw new NotFoundError('Customer');
  return toDTO(doc as unknown as Record<string, unknown>);
}

/**
 * Typeahead search. Up to 20 hits. Matches by:
 *   - CardCode prefix (case-insensitive, anchored at start)
 *   - CardName fragment (case-insensitive, anywhere)
 *
 * Empty / whitespace-only query returns an empty list — no point shipping a
 * naked 500-row dump to the FE typeahead.
 */
export async function searchCustomers(
  companyKey: string,
  query: string,
): Promise<CustomerLookupDTO[]> {
  const q = (query ?? '').trim();
  if (!q) return [];
  const models = await getTenantModelsFor(companyKey);

  // Escape regex metachars so a query like "C.001" doesn't blow up.
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = new RegExp(`^${safe}`, 'i');
  const anywhere = new RegExp(safe, 'i');

  const docs = await models.Customer.find(
    { $or: [{ CardCode: prefix }, { CardName: anywhere }] },
    projection,
  )
    .limit(20)
    .lean();

  return docs.map((d) => toDTO(d as unknown as Record<string, unknown>));
}
