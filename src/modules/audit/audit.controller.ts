import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { AuditMaster } from '../../models/master/AuditMaster';

export const listQuerySchema = z.object({
  action: z.string().optional(),
  actorEmail: z.string().optional(),
  companyKey: z.string().optional(),
  subjectType: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const list = asyncHandler<unknown, unknown, unknown, ListQuery>(async (req, res) => {
  const q = req.query;
  const filter: Record<string, unknown> = {};
  if (q.action) filter.action = q.action;
  if (q.actorEmail) filter.actorEmail = q.actorEmail;
  if (q.companyKey) filter.companyKey = q.companyKey;
  if (q.subjectType) filter.subjectType = q.subjectType;
  if (q.from || q.to) {
    const ts: Record<string, Date> = {};
    if (q.from) ts.$gte = q.from;
    if (q.to) ts.$lte = q.to;
    filter.ts = ts;
  }

  const total = await AuditMaster.countDocuments(filter);
  const items = await AuditMaster.find(filter)
    .sort({ ts: -1, _id: -1 })
    .skip((q.page - 1) * q.limit)
    .limit(q.limit)
    .lean();

  res.json({
    items: items.map((i) => ({
      id: i._id.toString(),
      ts: i.ts,
      action: i.action,
      actorEmail: i.actorEmail,
      subjectType: i.subjectType,
      subjectId: i.subjectId,
      companyKey: i.companyKey,
      ip: i.ip,
      reason: i.reason,
      hash: i.hash,
    })),
    total,
    page: q.page,
    limit: q.limit,
    pages: Math.max(1, Math.ceil(total / q.limit)),
  });
});

export const detail = asyncHandler<{ id: string }>(async (req, res) => {
  const doc = await AuditMaster.findById(req.params.id).lean();
  if (!doc) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Audit entry not found' } });
    return;
  }
  res.json(doc);
});
