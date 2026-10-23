import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { getAppDataSource } from '../db/connection.js';
import { requireAdmin } from '../utils/requireAdmin.js';

export async function submitLoopGuardFeedback(req: Request, res: Response): Promise<void> {
  if (!await requireAdmin(req, res)) return;
  const resultId = String(req.params.id ?? '');
  const verdict = req.body?.verdict;
  const reviewer = (req as any).user?.username;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resultId) ||
    !['helpful', 'false_positive', 'ignored'].includes(verdict) || typeof reviewer !== 'string' || !reviewer) {
    res.status(400).json({ success: false, message: 'Invalid LoopGuard feedback' }); return;
  }
  try {
    const rows = await getAppDataSource().query(`WITH feedback AS (
      INSERT INTO tool_result_loop_feedback (feedback_id, result_id, verdict, reviewed_by)
      SELECT $1,$2,$3,$4 FROM tool_result_state WHERE result_id=$2 AND loop_guard_advice IS NOT NULL
      RETURNING feedback_id, result_id, verdict, reviewed_by, reviewed_at
    ) UPDATE tool_result_state state SET loop_guard_feedback=jsonb_build_object(
      'verdict', feedback.verdict, 'reviewedBy', feedback.reviewed_by, 'reviewedAt', feedback.reviewed_at)
      FROM feedback WHERE state.result_id=feedback.result_id RETURNING state.loop_guard_feedback`,
    [randomUUID(), resultId, verdict, reviewer]);
    if (!rows.length) { res.status(404).json({ success: false, message: 'LoopGuard advice not found' }); return; }
    res.json({ success: true, data: rows[0].loop_guard_feedback });
  } catch { res.status(503).json({ success: false, message: 'LoopGuard feedback is unavailable' }); }
}
