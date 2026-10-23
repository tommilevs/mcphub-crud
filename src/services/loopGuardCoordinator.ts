import type { ToolResultRecord } from '../types/toolResult.js';
import { getAppDataSource } from '../db/connection.js';
import { detectRepeatedFailure, type LoopGuardAdvice } from './loopGuard.js';

export async function observeLoopGuard(record: ToolResultRecord): Promise<LoopGuardAdvice | null> {
  const context = record.attribution;
  if (process.env.MCPHUB_LOOP_GUARD_ENABLED !== 'true' || record.status !== 'error' ||
    !context?.traceId || !context.branchId) return null;
  try {
    const db = getAppDataSource();
    const rows = await db.query(`SELECT result_id, timestamp, server, tool, status, arguments, raw_sha256
      FROM tool_results WHERE username IS NOT DISTINCT FROM $1 AND key_id IS NOT DISTINCT FROM $2
        AND attribution->>'traceId' = $3 AND attribution->>'branchId' = $4
        AND timestamp <= $5 AND result_id <> $6 ORDER BY timestamp DESC, result_id DESC LIMIT 5`,
    [record.username ?? null, record.keyId ?? null, context.traceId, context.branchId, record.timestamp, record.resultId]);
    const advice = detectRepeatedFailure([{ resultId: record.resultId, timestamp: record.timestamp,
      server: record.server, tool: record.tool, status: record.status, arguments: record.arguments,
      resultDigest: record.rawSha256 }, ...rows.map((row: any) => ({ resultId: row.result_id,
      timestamp: new Date(row.timestamp), server: row.server, tool: row.tool,
      status: row.status, arguments: row.arguments, resultDigest: row.raw_sha256 }))]);
    if (advice) await db.query('UPDATE tool_result_state SET loop_guard_advice=$2::jsonb WHERE result_id=$1', [record.resultId, JSON.stringify(advice)]);
    return advice;
  } catch { return null; }
}
