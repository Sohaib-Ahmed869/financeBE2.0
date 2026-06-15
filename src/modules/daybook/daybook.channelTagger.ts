import { Company } from '../../models/master/Company';

export type DeliveryChannel = 'pos' | 'own-company' | 'external-transport' | 'own-delivery';

/**
 * Resolve a livraison's sales channel from the data on hand.
 *
 * Idris's framing from the 14/05/2026 call: he wants four channels surfaced
 * on the dashboard — POS, own-company (inter-branch), external-transport,
 * own-delivery (default). Tagged at entry time so historical reports work
 * without re-classifying.
 *
 * Resolution order:
 *   1. Explicit user choice if `userChoice` is set (and not the implicit default).
 *   2. POS — never applies to livraisons (those are driver deliveries by
 *      definition); kept here so the same helper covers invoices later.
 *   3. own-company — CardCode is in the active company's `ownCompanyCardCodes`.
 *   4. own-delivery — the default fall-through.
 */
export interface ChannelTagInput {
  cardCode: string;
  userChoice?: DeliveryChannel;
}

export function tagDeliveryChannel(
  input: ChannelTagInput,
  ownCompanyCardCodes: Set<string>,
): DeliveryChannel {
  if (input.userChoice === 'external-transport') return 'external-transport';
  if (input.userChoice === 'pos') return 'pos';

  const card = (input.cardCode ?? '').trim().toUpperCase();
  if (card && ownCompanyCardCodes.has(card)) return 'own-company';

  // Otherwise default to own-delivery; user can override later.
  return input.userChoice ?? 'own-delivery';
}

/**
 * Cached per-tenant lookup of the own-company card codes. Tiny set, rarely
 * changes — we pull it once per request via the master Company doc.
 */
const cache = new Map<string, { codes: Set<string>; loadedAt: number }>();
const TTL_MS = 30_000;

export async function getOwnCompanyCardCodes(companyKey: string): Promise<Set<string>> {
  const cached = cache.get(companyKey);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.codes;
  const co = await Company.findOne({ key: companyKey })
    .select({ ownCompanyCardCodes: 1 })
    .lean();
  const codes = new Set<string>(
    (co?.ownCompanyCardCodes ?? []).map((c) => c.trim().toUpperCase()).filter((c) => c.length > 0),
  );
  cache.set(companyKey, { codes, loadedAt: Date.now() });
  return codes;
}

/** Test-only — drop any cached entry. */
export function _resetChannelTaggerCache(): void {
  cache.clear();
}
