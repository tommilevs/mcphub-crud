import { detectRepeatedFailure } from '../../src/services/loopGuard.js';

const observation = (index: number, overrides = {}) => ({
  resultId: `result-${index}`, server: 'demo', tool: 'inspect', status: 'error',
  arguments: '{}', resultDigest: 'same-error', timestamp: new Date(1000 * index), ...overrides,
});
test('advises after three identical rapid failures without suppressing execution', () => {
  expect(detectRepeatedFailure([observation(3), observation(2), observation(1)])).toMatchObject({
    trigger: 'repeated_identical_failure', resultIds: ['result-3', 'result-2', 'result-1'],
  });
});

test('explicit repeat intent suppresses advice even for identical rapid errors', () => {
  for (const repeatIntent of ['poll', 'pagination', 'wait', 'retry']) {
    expect(detectRepeatedFailure([observation(3, { repeatIntent }), observation(2), observation(1)])).toBeNull();
  }
});
test('does not flag success, changed output, pagination, polling or backoff retries', () => {
  for (const entries of [
    [observation(3, { status: 'success' }), observation(2), observation(1)],
    [observation(3, { resultDigest: 'changed' }), observation(2), observation(1)],
    [observation(3, { arguments: '{"page":2}' }), observation(2), observation(1)],
    [observation(3, { tool: 'wait_for_status' }), observation(2, { tool: 'wait_for_status' }), observation(1, { tool: 'wait_for_status' })],
    [observation(30), observation(15), observation(1)],
  ]) expect(detectRepeatedFailure(entries)).toBeNull();
});

test('detects three rapid repetitions of a two-step error cycle', () => {
  const calls = Array.from({ length: 6 }, (_, index) => observation(6 - index, {
    tool: index % 2 ? 'diagnose-b' : 'diagnose-a', resultDigest: index % 2 ? 'error-b' : 'error-a',
  }));
  expect(detectRepeatedFailure(calls)?.trigger).toBe('alternating_failure_cycle');
  calls[3].resultDigest = 'new-evidence';
  expect(detectRepeatedFailure(calls)).toBeNull();
});

test('successful intermediate calls and backoff in older cycle steps suppress advice', () => {
  for (const change of [{ status: 'success' }, { timestamp: new Date(-20000) }, { tool: 'poll_device' }]) {
    const calls = Array.from({ length: 6 }, (_, index) => observation(6 - index, {
      tool: index % 2 ? 'diagnose-b' : 'diagnose-a', resultDigest: index % 2 ? 'error-b' : 'error-a',
    }));
    Object.assign(calls[4], change);
    expect(detectRepeatedFailure(calls)).toBeNull();
  }
});
