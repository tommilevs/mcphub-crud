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
test('does not flag success, changed output, pagination, polling or backoff retries', () => {
  for (const entries of [
    [observation(3, { status: 'success' }), observation(2), observation(1)],
    [observation(3, { resultDigest: 'changed' }), observation(2), observation(1)],
    [observation(3, { arguments: '{"page":2}' }), observation(2), observation(1)],
    [observation(3, { tool: 'wait_for_status' }), observation(2, { tool: 'wait_for_status' }), observation(1, { tool: 'wait_for_status' })],
    [observation(30), observation(15), observation(1)],
  ]) expect(detectRepeatedFailure(entries)).toBeNull();
});
