import type { ToolResultRecord } from '../types/toolResult.js';
import { getAppDataSource } from '../db/connection.js';
import { detectRepeatedFailure,detectUnchangedSuccess, type LoopGuardAdvice } from './loopGuard.js';
import { getSmartRoutingConfig } from '../utils/smartRouting.js';
import { escalateLoopGuard } from './toolPilot.js';
import {getExperienceAdvice} from './experienceAdvice.js';
import {getCachedSystemConfig} from '../utils/systemConfigCache.js';

export async function observeLoopGuard(record: ToolResultRecord): Promise<LoopGuardAdvice | null> {
  const context = record.attribution;
  if (!['error','success'].includes(record.status) ||
    !context?.traceId || !context.branchId) return null;
  // Successful calls keep their old fast path unless the loaded settings explicitly opt in.
  if(record.status==='success'&&!getCachedSystemConfig()?.smartRouting?.loopGuardUnchangedTools?.includes(`${record.server}/${record.tool}`))return null;
  try {
    const config = await getSmartRoutingConfig();
    if (!config.loopGuardEnabled || config.loopGuardIgnoredTools?.includes(`${record.server}/${record.tool}`)) return null;
    const unchanged=record.status==='success';
    if(unchanged&&!config.loopGuardUnchangedTools?.includes(`${record.server}/${record.tool}`))return null;
    const defaultRepetitions = config.loopGuardRepetitions ?? 3;
    const budgets = config.loopGuardToolBudgets ?? {};
    const budgetFor = (server: string, tool: string) => budgets[`${server}/${tool}`] ?? defaultRepetitions;
    const historyLimit = Math.max(unchanged?5:defaultRepetitions,defaultRepetitions, ...Object.values(budgets)) * 2 - 1;
    const db = getAppDataSource();
    const rows = await db.query(`SELECT result_id, timestamp, server, tool, status, arguments, raw_sha256, attribution->>'repeatIntent' AS repeat_intent
      FROM tool_results WHERE username IS NOT DISTINCT FROM $1 AND key_id IS NOT DISTINCT FROM $2
        AND attribution->>'traceId' = $3 AND attribution->>'branchId' = $4
        AND timestamp <= $5 AND result_id <> $6 ORDER BY timestamp DESC, result_id DESC LIMIT $7`,
    [record.username ?? null, record.keyId ?? null, context.traceId, context.branchId, record.timestamp, record.resultId, historyLimit]);
    // A/B cycles must respect both tools' policies, whichever tool is current.
    const repetitions = Math.max(budgetFor(record.server, record.tool),
      rows[0] ? budgetFor(rows[0].server, rows[0].tool) : 3);
    const detect=unchanged?detectUnchangedSuccess:detectRepeatedFailure;
    const advice = detect([{ resultId: record.resultId, timestamp: record.timestamp,
      server: record.server, tool: record.tool, status: record.status, arguments: record.arguments,
      resultDigest: record.rawSha256, repeatIntent: context.repeatIntent }, ...rows.map((row: any) => ({ resultId: row.result_id,
      timestamp: new Date(row.timestamp), server: row.server, tool: row.tool,
      status: row.status, arguments: row.arguments, resultDigest: row.raw_sha256, repeatIntent: row.repeat_intent }))], { repetitions:unchanged?Math.max(5,budgetFor(record.server,record.tool)):repetitions });
    if (advice && rows.some((row: any) => advice.resultIds.includes(row.result_id) &&
      config.loopGuardIgnoredTools?.includes(`${row.server}/${row.tool}`))) return null;
    if (advice) {
      const experiences=await getExperienceAdvice({username:record.username,keyId:record.keyId,server:record.server,tool:record.tool});
      if(experiences.length)advice.experiences=experiences;
      const suggestion = await escalateLoopGuard(advice, { server: record.server, tool: record.tool },
        { traceId: context.traceId, branchId: context.branchId });
      if (suggestion) advice.toolPilot = suggestion;
      // Store references only: later retirement/privacy revocation must not leave cached strategy text.
      const persisted={...advice,...(advice.experiences?{experiences:advice.experiences.map(({title:_title,summary:_summary,...reference})=>reference)}:{})};
      await db.query('UPDATE tool_result_state SET loop_guard_advice=$2::jsonb WHERE result_id=$1', [record.resultId, JSON.stringify(persisted)]);
    }
    return advice;
  } catch { return null; }
}
