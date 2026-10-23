export interface LoopGuardAdvice {
  toolPilot?: import('./toolPilot.js').ToolPilotSuggestion;
  trigger: 'repeated_identical_failure' | 'alternating_failure_cycle';
  resultIds: string[];
  recommendation: string;
}
export interface LoopGuardObservation {
  resultId: string;
  timestamp: Date;
  server: string;
  tool: string;
  status: string;
  arguments: string | null;
  resultDigest: string | null;
  repeatIntent?: string;
}

/** Conservative advisory only. Never authorizes, suppresses or replays a tool. */
const eligible = (call: LoopGuardObservation): boolean => {
  if (call.repeatIntent && ['poll', 'pagination', 'wait', 'retry'].includes(call.repeatIntent)) return false;
  if (call.status !== 'error' || !call.resultDigest || !call.arguments ||
    !Number.isFinite(call.timestamp.getTime()) || /(?:poll|wait|read_process_output|status)/i.test(call.tool)) return false;
  try {
    const args = JSON.parse(call.arguments);
    return !(args && typeof args === 'object' && ['page', 'cursor', 'offset', 'continuationToken'].some((key) => key in args));
  } catch { return false; }
};
const same = (a: LoopGuardObservation, b: LoopGuardObservation) => a.server === b.server &&
  a.tool === b.tool && a.arguments === b.arguments && a.resultDigest === b.resultDigest;
const rapidFailures = (calls: LoopGuardObservation[]) => {
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    if (!eligible(call)) return false;
    if (index && (calls[index - 1].timestamp.getTime() - call.timestamp.getTime() >= 10_000 ||
      calls[index - 1].timestamp.getTime() < call.timestamp.getTime())) return false;
  }
  return true;
};
export function detectRepeatedFailure(recent: LoopGuardObservation[], policy: { repetitions?: number } = {}): LoopGuardAdvice | null {
  const repetitions = policy.repetitions ?? 3;
  if (!Number.isInteger(repetitions) || repetitions < 3 || repetitions > 100) return null;
  const identical = recent.slice(0, repetitions);
  if (identical.length < repetitions || !rapidFailures(identical)) return null;
  if (identical.every((call) => same(call, identical[0]))) {
    return { trigger: 'repeated_identical_failure', resultIds: identical.map((call) => call.resultId),
      recommendation: `${repetitions} identical rapid failures were observed. Review the saved error and tool schema, then consider a different diagnostic step before retrying. Intentional retries may continue.` };
  }
  const cycle = recent.slice(0, repetitions * 2);
  if (cycle.length === repetitions * 2 && rapidFailures(cycle) && cycle.every((call, index) => same(call, cycle[index % 2]))) {
    return { trigger: 'alternating_failure_cycle', resultIds: cycle.map((call) => call.resultId),
      recommendation: `A two-step failure cycle repeated ${repetitions} times. Review both saved errors and consider changing the diagnostic strategy. Intentional retries may continue.` };
  }
  return null;
}
