import type { ToolResultRecord } from '../types/toolResult.js';
import { getAppDataSource } from '../db/connection.js';
import { detectRepeatedFailure, type LoopGuardAdvice } from './loopGuard.js';
import { getSmartRoutingConfig } from '../utils/smartRouting.js';

export async function observeLoopGuard(record: ToolResultRecord): Promise<LoopGuardAdvice | null> {
  const context = record.attribution;
  if (record.status !== 'error' ||
    !context?.traceId || !context.branchId) return null;
  try {
    const config = await getSmartRoutingConfig();
    if (!config.loopGuardEnabled || config.loopGuardIgnoredTools?.includes(`${record.server}/${record.tool}`)) return null;
    const defaultRepetitions = config.loopGuardRepetitions ?? 3;
    const budgets = config.loopGuardToolBudgets ?? {};
    const budgetFor = (server: string, tool: string) => budgets[`${server}/${tool}`] ?? defaultRepetitions;
    const historyLimit = Math.max(defaultRepetitions, ...Object.values(budgets)) * 2 - 1;
    const db = getAppDataSource();
    const rows = await db.query(`SELECT result_id, timestamp, server, tool, status, arguments, raw_sha256, attribution->>'repeatIntent' AS repeat_intent
      FROM tool_results WHERE username IS NOT DISTINCT FROM $1 AND key_id IS NOT DISTINCT FROM $2
        AND attribution->>'traceId' = $3 AND attribution->>'branchId' = $4
        AND timestamp <= $5 AND result_id <> $6 ORDER BY timestamp DESC, result_id DESC LIMIT $7`,
    [record.username ?? null, record.keyId ?? null, context.traceId, context.branchId, record.timestamp, record.resultId, historyLimit]);
    // A/B cycles must respect both tools' policies, whichever tool is current.
    const repetitions = Math.max(budgetFor(record.server, record.tool),
      rows[0] ? budgetFor(rows[0].server, rows[0].tool) : 3);
    const advice = detectRepeatedFailure([{ resultId: record.resultId, timestamp: record.timestamp,
      server: record.server, tool: record.tool, status: record.status, arguments: record.arguments,
      resultDigest: record.rawSha256, repeatIntent: context.repeatIntent }, ...rows.map((row: any) => ({ resultId: row.result_id,
      timestamp: new Date(row.timestamp), server: row.server, tool: row.tool,
      status: row.status, arguments: row.arguments, resultDigest: row.raw_sha256, repeatIntent: row.repeat_intent }))], { repetitions });
    if (advice && rows.some((row: any) => advice.resultIds.includes(row.result_id) &&
      config.loopGuardIgnoredTools?.includes(`${row.server}/${row.tool}`))) return null;
    if (advice) await db.query('UPDATE tool_result_state SET loop_guard_advice=$2::jsonb WHERE result_id=$1', [record.resultId, JSON.stringify(advice)]);
    return advice;
  } catch { return null; }
}
