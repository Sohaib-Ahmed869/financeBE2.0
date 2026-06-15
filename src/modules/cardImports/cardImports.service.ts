import { Types } from 'mongoose';
import { getTenantModelsFor } from '../../db/tenant';
import { audit } from '../../lib/audit';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import {
  parsePaypalCsv,
  parseSogecommerceTransactions,
  parseSogecommerceRemises,
  type CardImportRow,
  type CardImportParseResult,
} from './cardImports.parser';

interface ActorMeta {
  userId: string;
  email: string;
  ip: string;
}

interface UploadFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export type CardProvider = 'sogecommerce-site' | 'sogecommerce-phone' | 'paypal';

/**
 * Identifier kind used in `LearnedPattern.signature` to remember which
 * customer a card / PayPal payer belongs to. Once the user assigns a
 * cardCode to a row, the same masked PAN (CB) or email/name (PayPal) is
 * auto-mapped on every subsequent upload — Idris asked for this directly:
 * "the system should remember that for the next time".
 */
type IdentityKind = 'card-pan' | 'paypal-email' | 'paypal-name';

interface LearnedFeatures {
  provider: CardProvider;
  identityKind: IdentityKind;
  identifier: string;
  cardCode: string;
  cardName?: string;
}

function signatureFor(provider: CardProvider, kind: IdentityKind, identifier: string): string {
  return `payment-source|${provider}|${kind}|${identifier.toLowerCase()}`;
}

function identitiesFor(row: CardImportRow, provider: CardProvider): Array<{
  kind: IdentityKind;
  identifier: string;
}> {
  const out: Array<{ kind: IdentityKind; identifier: string }> = [];
  if (provider === 'paypal') {
    if (row.payerEmail) out.push({ kind: 'paypal-email', identifier: row.payerEmail });
    if (row.payerName) out.push({ kind: 'paypal-name', identifier: row.payerName });
  } else {
    if (row.maskedPan) out.push({ kind: 'card-pan', identifier: row.maskedPan });
  }
  return out;
}

function chooseParser(file: UploadFile, providerHint?: CardProvider): {
  provider: CardProvider;
  parse: () => CardImportParseResult;
} {
  const name = file.originalname.toLowerCase();
  if (providerHint === 'paypal' || /paypal/i.test(name)) {
    return { provider: 'paypal', parse: () => parsePaypalCsv(file.buffer) };
  }
  if (/listing_transactions|listing_tx|transactions_remisees/.test(name)) {
    return {
      provider: providerHint ?? 'sogecommerce-site',
      parse: () =>
        parseSogecommerceTransactions(file.buffer, {
          defaultChannel: providerHint === 'sogecommerce-phone' ? 'phone' : 'site',
        }),
    };
  }
  // Default to PayPal for .csv, Sogecommerce for .xls/.xlsx
  if (/\.csv$/i.test(name)) {
    return { provider: 'paypal', parse: () => parsePaypalCsv(file.buffer) };
  }
  return {
    provider: providerHint ?? 'sogecommerce-site',
    parse: () =>
      parseSogecommerceTransactions(file.buffer, {
        defaultChannel: providerHint === 'sogecommerce-phone' ? 'phone' : 'site',
      }),
  };
}

export async function uploadCardImport(
  companyKey: string,
  file: UploadFile,
  meta: { provider?: CardProvider } = {},
  actor: ActorMeta,
) {
  if (!file?.buffer || file.size === 0) throw new BadRequestError('Empty upload');
  const models = await getTenantModelsFor(companyKey);

  const { provider, parse } = chooseParser(file, meta.provider);
  const parsed = parse();
  if (parsed.rows.length === 0) {
    throw new BadRequestError(
      `No usable rows. Warnings: ${parsed.warnings.join('; ') || '(none)'}`,
    );
  }

  // Pre-load every learned mapping the upload could reference in one shot —
  // cheaper than N round-trips when uploading a month at a time.
  const wantedSignatures = new Set<string>();
  for (const r of parsed.rows) {
    for (const id of identitiesFor(r, provider)) {
      wantedSignatures.add(signatureFor(provider, id.kind, id.identifier));
    }
  }
  const learned = (await models.LearnedPattern.find({
    signature: { $in: Array.from(wantedSignatures) },
  })
    .select({ signature: 1, features: 1 })
    .lean()) as unknown as Array<{ signature: string; features: LearnedFeatures }>;
  const byKey = new Map<string, { cardCode: string; cardName?: string }>();
  for (const lp of learned) {
    if (lp.features?.cardCode) {
      byKey.set(lp.signature, {
        cardCode: lp.features.cardCode,
        cardName: lp.features.cardName,
      });
    }
  }

  const importFile = await models.ImportFile.create({
    provider,
    periodStart: parsed.periodStart ? new Date(`${parsed.periodStart}T00:00:00.000Z`) : null,
    periodEnd: parsed.periodEnd ? new Date(`${parsed.periodEnd}T00:00:00.000Z`) : null,
    status: 'parsed',
    parsedRowCount: parsed.rows.length,
    totalAmount: parsed.totalAmount,
    uploadedByEmail: actor.email,
    parsedAt: new Date(),
  });

  let autoResolved = 0;
  let inserted = 0;
  for (const row of parsed.rows) {
    // Find the first identity for this row that we already have a mapping for.
    let cardCodeHint: string | undefined;
    let cardName: string | undefined;
    for (const id of identitiesFor(row, provider)) {
      const hit = byKey.get(signatureFor(provider, id.kind, id.identifier));
      if (hit) {
        cardCodeHint = hit.cardCode;
        cardName = hit.cardName;
        break;
      }
    }
    if (cardCodeHint) autoResolved++;

    try {
      await models.ImportRow.create({
        importFileId: importFile._id,
        transactionId: row.transactionId,
        raw: row.raw,
        normalized: {
          date: new Date(`${row.date}T00:00:00.000Z`),
          amount: row.amount,
          currency: 'EUR',
          method: row.method,
          payerName: row.payerName,
          payerEmail: row.payerEmail,
          cardCodeHint: cardCodeHint ?? '',
          reference: row.remiseNumber ?? row.maskedPan ?? '',
        },
        status: cardCodeHint ? 'matched' : 'pending',
      });
      inserted++;
    } catch (err) {
      // Idempotent upload: duplicate (importFileId, transactionId) is fine.
      if (!String(err).includes('duplicate key')) throw err;
    }
  }

  await models.ImportFile.updateOne(
    { _id: importFile._id },
    { $set: { successRowCount: autoResolved, status: 'imported', importedAt: new Date() } },
  );

  await audit({
    action: 'cardImport.upload',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'ImportFile',
    subjectId: importFile._id.toString(),
    companyKey,
    after: {
      provider,
      filename: file.originalname,
      rows: parsed.rows.length,
      autoResolved,
      total: parsed.totalAmount,
    },
    ip: actor.ip,
  });

  return {
    id: importFile._id.toString(),
    provider,
    rows: parsed.rows.length,
    inserted,
    autoResolved,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    totalAmount: parsed.totalAmount,
    warnings: parsed.warnings,
  };
}

/**
 * Sogecommerce daily-settlement file — sits separately from per-transaction
 * imports because its rows aren't customer payments, they're bank deposits.
 * Stored on the daybook's bank-statement view so the user can clear bank
 * lines by remise number.
 */
export async function uploadRemiseFile(
  companyKey: string,
  file: UploadFile,
  actor: ActorMeta,
) {
  if (!file?.buffer || file.size === 0) throw new BadRequestError('Empty upload');
  const parsed = parseSogecommerceRemises(file.buffer);
  if (parsed.rows.length === 0) {
    throw new BadRequestError(`No remises found. Warnings: ${parsed.warnings.join('; ') || '(none)'}`);
  }
  const models = await getTenantModelsFor(companyKey);
  const importFile = await models.ImportFile.create({
    provider: 'other',
    periodStart: parsed.periodStart ? new Date(`${parsed.periodStart}T00:00:00.000Z`) : null,
    periodEnd: parsed.periodEnd ? new Date(`${parsed.periodEnd}T00:00:00.000Z`) : null,
    status: 'imported',
    parsedRowCount: parsed.rows.length,
    successRowCount: parsed.rows.length,
    totalAmount: parsed.totalAmount,
    uploadedByEmail: actor.email,
    parsedAt: new Date(),
    importedAt: new Date(),
  });
  for (const r of parsed.rows) {
    try {
      await models.ImportRow.create({
        importFileId: importFile._id,
        transactionId: r.remiseNumber,
        raw: r.raw,
        normalized: {
          date: new Date(`${r.date}T00:00:00.000Z`),
          amount: r.amount,
          currency: 'EUR',
          method: 'remise',
          payerName: '',
          payerEmail: '',
          cardCodeHint: '',
          reference: r.remiseNumber,
        },
        status: 'matched',
      });
    } catch (err) {
      if (!String(err).includes('duplicate key')) throw err;
    }
  }
  await audit({
    action: 'cardImport.uploadRemises',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'ImportFile',
    subjectId: importFile._id.toString(),
    companyKey,
    after: { rows: parsed.rows.length, total: parsed.totalAmount },
    ip: actor.ip,
  });
  return {
    id: importFile._id.toString(),
    rows: parsed.rows.length,
    totalAmount: parsed.totalAmount,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
  };
}

export async function listCardImports(companyKey: string) {
  const models = await getTenantModelsFor(companyKey);
  const items = await models.ImportFile.find({})
    .sort({ periodStart: -1 })
    .lean();
  return {
    items: items.map((f) => ({
      id: f._id.toString(),
      provider: f.provider,
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      status: f.status,
      rows: f.parsedRowCount,
      autoResolved: f.successRowCount,
      totalAmount: f.totalAmount,
      uploadedByEmail: f.uploadedByEmail,
      uploadedAt: f.createdAt,
    })),
  };
}

export async function getCardImport(companyKey: string, importId: string) {
  const models = await getTenantModelsFor(companyKey);
  const id = new Types.ObjectId(importId);
  const file = await models.ImportFile.findById(id).lean();
  if (!file) throw new NotFoundError('ImportFile');
  const rows = await models.ImportRow.find({ importFileId: id })
    .sort({ 'normalized.date': 1 })
    .lean();
  return {
    file: {
      id: file._id.toString(),
      provider: file.provider,
      periodStart: file.periodStart,
      periodEnd: file.periodEnd,
      status: file.status,
      rows: file.parsedRowCount,
      autoResolved: file.successRowCount,
      totalAmount: file.totalAmount,
      uploadedByEmail: file.uploadedByEmail,
      uploadedAt: file.createdAt,
    },
    rows: rows.map((r) => ({
      id: r._id.toString(),
      transactionId: r.transactionId,
      date: r.normalized?.date,
      amount: r.normalized?.amount,
      method: r.normalized?.method,
      payerName: r.normalized?.payerName,
      payerEmail: r.normalized?.payerEmail,
      cardCodeHint: r.normalized?.cardCodeHint,
      reference: r.normalized?.reference,
      status: r.status,
      paymentEntryId: r.paymentEntryId ? r.paymentEntryId.toString() : null,
      raw: r.raw,
    })),
  };
}

/**
 * Assign a SAP customer to one ImportRow. Learns the (provider, payer
 * identity) → cardCode mapping in `LearnedPattern` so future uploads
 * auto-resolve. When `createPaymentEntry` is true, also drafts the
 * PaymentEntry that will eventually be pushed to SAP.
 */
export async function assignCardCode(
  companyKey: string,
  importRowId: string,
  patch: { cardCode: string; cardName?: string; createPaymentEntry?: boolean },
  actor: ActorMeta,
) {
  const models = await getTenantModelsFor(companyKey);
  const row = await models.ImportRow.findById(new Types.ObjectId(importRowId));
  if (!row) throw new NotFoundError('ImportRow');
  const file = await models.ImportFile.findById(row.importFileId).lean();
  if (!file) throw new NotFoundError('ImportFile');
  const cardCode = patch.cardCode.trim().toUpperCase();
  if (!cardCode) throw new BadRequestError('cardCode required');

  // Customer lookup is best-effort — let the user assign codes that aren't yet
  // synced (the customer sync will catch up). Capture cardName when we can.
  const customer = (await models.Customer.findOne({ CardCode: cardCode })
    .select({ CardCode: 1, CardName: 1 })
    .lean()) as { CardCode?: string; CardName?: string } | null;
  const cardName = patch.cardName ?? customer?.CardName ?? '';

  row.set('normalized.cardCodeHint', cardCode);
  row.status = 'matched';
  await row.save();

  // Learn the mapping(s). PayPal: by email + name. Sogecommerce: by masked PAN.
  const provider = file.provider as CardProvider;
  const identities: Array<{ kind: IdentityKind; identifier: string }> = [];
  if (provider === 'paypal') {
    if (row.normalized?.payerEmail) {
      identities.push({ kind: 'paypal-email', identifier: row.normalized.payerEmail });
    }
    if (row.normalized?.payerName) {
      identities.push({ kind: 'paypal-name', identifier: row.normalized.payerName });
    }
  } else if (provider === 'sogecommerce-site' || provider === 'sogecommerce-phone') {
    const pan = String(row.raw?.['Numéro de carte'] ?? '').trim();
    if (pan) identities.push({ kind: 'card-pan', identifier: pan });
  }
  for (const id of identities) {
    const signature = signatureFor(provider, id.kind, id.identifier);
    const features: LearnedFeatures = {
      provider,
      identityKind: id.kind,
      identifier: id.identifier,
      cardCode,
      cardName,
    };
    await models.LearnedPattern.updateOne(
      { signature },
      {
        $set: {
          description: `Assign payer "${id.identifier}" → ${cardCode}`,
          features,
          suggestedAction: 'auto-match',
          confidence: 0.95,
          lastUsedAt: new Date(),
        },
        $inc: { hits: 1 },
        $setOnInsert: { createdAt: new Date(), active: true },
      },
      { upsert: true },
    );
  }

  // Optionally draft the PaymentEntry that gets pushed to SAP.
  if (patch.createPaymentEntry && row.normalized?.amount && row.normalized?.amount > 0) {
    const method = provider === 'paypal' ? 'PayPal' : 'CB-Site'; // CB-Phone never auto-resolves
    const entry = await models.PaymentEntry.create({
      cardCode,
      cardName,
      date: row.normalized.date,
      method,
      amount: row.normalized.amount,
      currency: 'EUR',
      card:
        provider === 'paypal'
          ? { processor: 'paypal', transactionId: row.transactionId }
          : {
              processor: provider,
              transactionId: row.transactionId,
              maskedPan: String(row.raw?.['Numéro de carte'] ?? '') || undefined,
            },
      sourceType: provider === 'paypal' ? 'paypal-import' : 'sogecommerce-import',
      sourceFileId: row.importFileId,
      sourceLineRef: row.transactionId,
      status: 'matched',
      enteredByEmail: actor.email,
      notes: `Imported ${provider} ${row.transactionId}`,
    });
    row.paymentEntryId = entry._id;
    row.status = 'created-payment';
    await row.save();
  }

  await audit({
    action: 'cardImport.assignCardCode',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectType: 'ImportRow',
    subjectId: importRowId,
    companyKey,
    after: { cardCode, cardName, createPaymentEntry: patch.createPaymentEntry ?? false },
    ip: actor.ip,
  });

  return getCardImport(companyKey, row.importFileId.toString());
}
