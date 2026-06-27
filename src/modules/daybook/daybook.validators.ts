import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optionalAmount = z.number().finite().nullable().optional();

const chequeLine = z.object({
  client: z.string().trim().min(1, 'Client required'),
  montant: z.number().finite().nullable().optional(),
});

const moneyRow = z.object({
  label: z.string().trim().min(1, 'Label required'),
  amount: z.number().finite().nullable().optional(),
});

const livraisonLine = z.object({
  codeClient: z.string().trim().default(''),
  clientName: z.string().trim().default(''),
  montant: z.number().finite().nullable().optional(),
  banque: z.string().trim().default(''),
  numero: z.string().trim().default(''),
  remarques: z.string().trim().default(''),
  sapStatusRaw: z.string().trim().default(''),
  montantEspeces: z.number().finite().nullable().optional(),
  montantCBSite: z.number().finite().nullable().optional(),
  montantCBPhone: z.number().finite().nullable().optional(),
  montantVirement: z.number().finite().nullable().optional(),
  referenceVirement: z.string().trim().default(''),
  nonPaye: z.boolean().default(false),
  deliveryChannel: z
    .enum(['pos', 'own-company', 'external-transport', 'own-delivery'])
    .optional(),
});

const bankSlip = z.object({
  ref: z.string().trim().default(''),
  amount: z.number().finite().nullable().optional(),
  kind: z.enum(['cash', 'cheques', 'mixed']).default('cash'),
});

const posExtraPayment = z.object({
  codeClient: z.string().trim().default(''),
  clientName: z.string().trim().default(''),
  method: z.enum(['card', 'cash', 'cheque']).default('card'),
  amount: z.number().finite().nullable().optional(),
  notes: z.string().trim().default(''),
});

export const dayParamSchema = z.object({ date: isoDate });

export const upsertDaySchema = z.object({
  totals: z
    .object({
      especes: optionalAmount,
      cheques: optionalAmount,
      carteCredit: optionalAmount,
      virement: optionalAmount,
    })
    .partial()
    .default({}),
  remiseBancaire: z
    .object({
      especes: optionalAmount,
      cheques: optionalAmount,
      monnaieNonDeposee: optionalAmount,
      bankSlipRefs: z.array(z.string().trim()).default([]),
      bankSlips: z.array(bankSlip).default([]),
    })
    .partial()
    .default({}),
  caisseEspeces: z
    .object({
      billets50: optionalAmount,
      billets20: optionalAmount,
      billets10: optionalAmount,
      billets5: optionalAmount,
      monnaie: optionalAmount,
      total: optionalAmount,
      fondCaisse: optionalAmount,
    })
    .partial()
    .default({}),
  caisseCheques: z.array(chequeLine).default([]),
  caisseChequesTotal: optionalAmount,
  caisseCB: z
    .object({
      till: optionalAmount,
      sansContact: optionalAmount,
      total: optionalAmount,
    })
    .partial()
    .default({}),
  differenceFondCaisse: optionalAmount,
  depenses: z.array(moneyRow).default([]),
  depensesTotal: optionalAmount,
  livraisons: z.array(livraisonLine).default([]),
  posExtraPayments: z.array(posExtraPayment).default([]),
});

export type UpsertDayInput = z.infer<typeof upsertDaySchema>;

export const setMatchSchema = z
  .object({
    status: z.enum(['manual', 'rejected', 'unmatched', 'on-account']),
    invoiceDocEntry: z.number().int().positive().nullable().optional(),
    notes: z.string().max(500).optional(),
  })
  .refine(
    (v) =>
      v.status !== 'manual' || (typeof v.invoiceDocEntry === 'number' && v.invoiceDocEntry > 0),
    { message: 'invoiceDocEntry required when status is "manual"', path: ['invoiceDocEntry'] },
  );

export const lineIndexParamSchema = z.object({
  date: isoDate,
  index: z.string().regex(/^\d+$/).transform(Number),
});

export type SetMatchInput = z.infer<typeof setMatchSchema>;

export const pushDaySchema = z.object({
  /** Optional whitelist — pushes only the listed indexes when set. */
  indexes: z.array(z.number().int().min(0)).optional(),
});

export type PushDayInput = z.infer<typeof pushDaySchema>;

export const pushPosExtrasSchema = z.object({
  /** Optional whitelist — pushes only the listed posExtraPayments indexes when set. */
  indexes: z.array(z.number().int().min(0)).optional(),
});

export type PushPosExtrasInput = z.infer<typeof pushPosExtrasSchema>;


