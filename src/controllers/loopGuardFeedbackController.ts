import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { getAppDataSource } from '../db/connection.js';
import { requireAdmin } from '../utils/requireAdmin.js';

export async function getLoopGuardSummary(req: Request, res: Response): Promise<void> {
  if (!await requireAdmin(req, res)) return;
  const days = Number(req.query.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    res.status(400).json({ success: false, message: 'Invalid summary period' }); return;
  }
  try {
    const rows = await getAppDataSource().query(`WITH advice AS (
      SELECT state.result_id, state.loop_guard_feedback->>'verdict' AS verdict
      FROM tool_result_state state JOIN tool_results result USING (result_id)
      WHERE state.loop_guard_advice IS NOT NULL
        AND result.timestamp >= NOW() - ($1::integer * INTERVAL '1 day')
    ), reactions AS (
      SELECT reaction.result_id, reaction.action FROM tool_result_loop_reactions reaction JOIN advice USING (result_id)
    ), counts AS (
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE verdict IN ('helpful','false_positive','ignored')) AS reviewed,
        COUNT(*) FILTER (WHERE verdict = 'helpful') AS helpful,
        COUNT(*) FILTER (WHERE verdict = 'false_positive') AS false_positive,
        COUNT(*) FILTER (WHERE verdict = 'ignored') AS ignored
      FROM advice
    ) SELECT json_build_object('advice', total, 'reviewed', reviewed,
      'helpful', helpful, 'falsePositive', false_positive, 'ignored', ignored,
      'unreviewed', total-reviewed, 'assessed', helpful+false_positive,
      'reportedFalsePositiveRate', false_positive::double precision / NULLIF(helpful+false_positive,0),
      'agentReactions', (SELECT json_build_object('reported', COUNT(*), 'warnings', COUNT(DISTINCT result_id),
        'accepted', COUNT(*) FILTER (WHERE action='accepted'),
        'declined', COUNT(*) FILTER (WHERE action='declined'),
        'changedStrategy', COUNT(*) FILTER (WHERE action='changed_strategy'),
        'intentionalRetry', COUNT(*) FILTER (WHERE action='intentional_retry'), 'source', 'self_reported') FROM reactions)
    ) AS summary FROM counts`, [days]);
    res.json({ success: true, data: rows[0].summary, meta: { days } });
  } catch { res.status(503).json({ success: false, message: 'LoopGuard summary is unavailable' }); }
}

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
