import type { Request, Response } from 'express';
import { getAppDataSource } from '../db/connection.js';
import { requireAdmin } from '../utils/requireAdmin.js';

export async function saveToolResultReview(req: Request, res: Response): Promise<void> {
  if (!await requireAdmin(req, res)) return;
  const resultId = String(req.params.id ?? '');
  const { quality, privacy, revision, rawSha256 } = req.body ?? {};
  const reviewer = (req as any).user?.username;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resultId) ||
    !['unknown','correct','incorrect','uncertain'].includes(quality) ||
    !['unreviewed','approved','rejected'].includes(privacy) ||
    !Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647 ||
    typeof rawSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rawSha256) || typeof reviewer !== 'string' || !reviewer) {
    res.status(400).json({ success: false, message: 'Invalid result review' }); return;
  }
  try {
    const rows = await getAppDataSource().query(`INSERT INTO tool_result_reviews
      (result_id,revision,raw_sha256,quality,privacy,reviewed_by)
      SELECT result_id,$2,raw_sha256,$3,$4,$5 FROM tool_results
      WHERE result_id=$1 AND raw_sha256=$6 AND payload_available=true
        AND COALESCE((SELECT MAX(revision) FROM tool_result_reviews WHERE result_id=$1),0)=$7
      ON CONFLICT (result_id,revision) DO NOTHING RETURNING *`,
    [resultId,revision+1,quality,privacy,reviewer,rawSha256,revision]);
    if (!rows.length) {
      res.status(409).json({ success: false, message: 'Result or review changed, or payload unavailable; reload before reviewing' }); return;
    }
    res.json({ success: true, data: rows[0] });
  } catch { res.status(503).json({ success: false, message: 'Result review is unavailable' }); }
}
