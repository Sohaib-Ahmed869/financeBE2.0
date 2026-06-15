import { asyncHandler } from '../../lib/asyncHandler';
import { Permission } from '../../models/master/Permission';

export const list = asyncHandler(async (_req, res) => {
  const docs = await Permission.find({}).sort({ domain: 1, action: 1 }).lean();
  res.json(
    docs.map((p) => ({
      key: p.key,
      domain: p.domain,
      action: p.action,
      description: p.description,
      riskLevel: p.riskLevel,
    })),
  );
});
