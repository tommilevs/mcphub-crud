import type { Request, Response } from 'express';
import { getAppDataSource } from '../db/connection.js';
import { requireAdmin } from '../utils/requireAdmin.js';

export async function saveTaskReview(req: Request, res: Response): Promise<void> {
  if (!await requireAdmin(req, res)) return;
  const taskId = String(req.params.taskId ?? '');
  const { outcome, trainingConsent, revision } = req.body ?? {};
  const username = (req as any).user?.username;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId) ||
    !['unknown', 'success', 'failure', 'partial', 'abandoned'].includes(outcome) ||
    typeof trainingConsent !== 'boolean' || !Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647 ||
    typeof username !== 'string' || !username) {
    res.status(400).json({ success: false, message: 'Invalid task review' });
    return;
  }
  try {
    const rows = await getAppDataSource().query(`INSERT INTO attribution_task_reviews
      (task_id, revision, outcome, training_consent, reviewed_by)
      SELECT $1, $2, $3, $4, $5
      WHERE COALESCE((SELECT MAX(revision) FROM attribution_task_reviews WHERE task_id=$1), 0) = $6
        AND (EXISTS (SELECT 1 FROM attribution_contexts WHERE task_id=$1)
          OR EXISTS (SELECT 1 FROM tool_results WHERE attribution->>'taskId' = $1::text))
      ON CONFLICT (task_id, revision) DO NOTHING RETURNING *`, [taskId, revision + 1, outcome, trainingConsent, username, revision]);
    if (!rows.length) {
      res.status(409).json({ success: false, message: 'Task review changed or task is unavailable; reload before saving' });
      return;
    }
    res.json({ success: true, data: rows[0] });
  } catch {
    res.status(503).json({ success: false, message: 'Task review is unavailable' });
  }
}
