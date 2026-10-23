import type { Request, Response } from 'express';
import { requireAdmin } from '../utils/requireAdmin.js';
import { getAppDataSource } from '../db/connection.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getAttributionSummary(req: Request, res: Response): Promise<void> {
  if (!await requireAdmin(req, res)) return;
  const days = Number(req.query.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    res.status(400).json({ success: false, message: 'Invalid summary period' });
    return;
  }
  try {
    const rows = await getAppDataSource().query(`WITH recent AS (
      SELECT attribution, status FROM tool_results
      WHERE timestamp >= NOW() - ($1::integer * INTERVAL '1 day')
    ), models AS (
      SELECT attribution->'identity'->>'modelId' AS model_id,
        COALESCE(attribution->'identity'->>'source', 'unknown') AS source,
        COUNT(*) AS calls, COUNT(*) FILTER (WHERE status = 'error') AS execution_errors
      FROM recent GROUP BY 1, 2 ORDER BY calls DESC, model_id NULLS LAST LIMIT 50
    ) SELECT json_build_object(
      'total', COUNT(*),
      'known', COUNT(*) FILTER (WHERE NULLIF(attribution->'identity'->>'modelId', '') IS NOT NULL AND attribution->>'conflictReason' IS NULL),
      'verified', COUNT(*) FILTER (WHERE attribution->'identity'->>'verified' = 'true' AND attribution->'identity'->>'source' IN ('gateway_observed', 'host_reported') AND attribution->'provenance'->>'causalCorrelationVerified' = 'true' AND attribution->>'conflictReason' IS NULL),
      'conflicted', COUNT(*) FILTER (WHERE attribution->>'conflictReason' IS NOT NULL),
      'executionErrors', COUNT(*) FILTER (WHERE status = 'error'),
      'models', COALESCE((SELECT json_agg(models) FROM models), '[]'::json)
    ) AS summary FROM recent`, [days]);
    res.json({ success: true, data: rows[0].summary, meta: { days } });
  } catch {
    res.status(503).json({ success: false, message: 'Attribution summary is unavailable' });
  }
}

export async function getAttributionEvents(req: Request, res: Response): Promise<void> {
  if (!await requireAdmin(req, res)) return;
  const traceId = String(req.params.traceId ?? '');
  const limit = Number(req.query.limit ?? 100);
  if (!UUID.test(traceId) ||
    !Number.isInteger(limit) || limit < 1 || limit > 500) {
    res.status(400).json({ success: false, message: 'Invalid trace or event limit' });
    return;
  }
  let cursor: [string, string] | undefined;
  if (req.query.cursor !== undefined) {
    try {
      if (typeof req.query.cursor !== 'string' || req.query.cursor.length > 256) throw new Error();
      const parsed = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' ||
        !Number.isFinite(Date.parse(parsed[0])) || typeof parsed[1] !== 'string' || !UUID.test(parsed[1])) throw new Error();
      cursor = [parsed[0], parsed[1]];
    } catch {
      res.status(400).json({ success: false, message: 'Invalid event cursor' });
      return;
    }
  }
  try {
    const rows = await getAppDataSource().query(`SELECT event_id, context_id, parent_context_id,
      task_id, trace_id, branch_id, model_segment_id, event_type, occurred_at,
      claimed_model_id, identity_source FROM attribution_identity_events
      WHERE trace_id = $1 ${cursor ? 'AND (occurred_at, event_id) > ($3::timestamptz, $4::uuid)' : ''}
      ORDER BY occurred_at ASC, event_id ASC LIMIT $2`, [traceId, limit + 1, ...(cursor ?? [])]);
    const data = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = data[data.length - 1];
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify([
      new Date(last.occurred_at).toISOString(), last.event_id,
    ])).toString('base64url') : undefined;
    res.json({ success: true, data, meta: { hasMore, limit, ...(nextCursor ? { nextCursor } : {}) } });
  } catch {
    res.status(503).json({ success: false, message: 'Attribution events are unavailable' });
  }
}
