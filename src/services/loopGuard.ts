export interface LoopGuardAdvice {
  trigger: 'repeated_identical_failure';
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
}

/** Conservative advisory only. Never authorizes, suppresses or replays a tool. */
export function detectRepeatedFailure(recent: LoopGuardObservation[]): LoopGuardAdvice | null {
  const calls = recent.slice(0, 3);
  const first = calls[0];
  if (calls.length < 3 || !first?.resultDigest || !first.arguments ||
    /(?:poll|wait|read_process_output|status)/i.test(first.tool)) return null;
  try {
    const args = JSON.parse(first.arguments);
    if (args && typeof args === 'object' && ['page', 'cursor', 'offset', 'continuationToken'].some((key) => key in args)) return null;
  } catch { return null; }
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    if (call.status !== 'error' || call.server !== first.server || call.tool !== first.tool ||
      call.arguments !== first.arguments || call.resultDigest !== first.resultDigest) return null;
    if (index && (calls[index - 1].timestamp.getTime() - call.timestamp.getTime() >= 10_000 ||
      calls[index - 1].timestamp.getTime() < call.timestamp.getTime())) return null;
  }
  return { trigger: 'repeated_identical_failure', resultIds: calls.map((call) => call.resultId),
    recommendation: 'Three identical rapid failures were observed. Review the saved error and tool schema, then consider a different diagnostic step before retrying. Intentional retries may continue.' };
}
