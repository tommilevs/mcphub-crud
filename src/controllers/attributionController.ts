import type { Request, Response } from 'express';
import { requireAdmin } from '../utils/requireAdmin.js';
import { getAppDataSource } from '../db/connection.js';

export async function getAttributionEvents(req: Request, res: Response): Promise<void> {
  if (!await requireAdmin(req, res)) return;
  const traceId = String(req.params.traceId ?? '');
  const limit = Number(req.query.limit ?? 100);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(traceId) ||
    !Number.isInteger(limit) || limit < 1 || limit > 500) {
    res.status(400).json({ success: false, message: 'Invalid trace or event limit' });
    return;
  }
  try {
    const rows = await getAppDataSource().query(`SELECT event_id, context_id, parent_context_id,
      task_id, trace_id, branch_id, model_segment_id, event_type, occurred_at,
      claimed_model_id, identity_source FROM attribution_identity_events
      WHERE trace_id = $1 ORDER BY occurred_at ASC, event_id ASC LIMIT $2`, [traceId, limit + 1]);
    res.json({ success: true, data: rows.slice(0, limit), meta: { hasMore: rows.length > limit, limit } });
  } catch {
    res.status(503).json({ success: false, message: 'Attribution events are unavailable' });
  }
}
