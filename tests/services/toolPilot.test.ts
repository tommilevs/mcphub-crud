const create = jest.fn();
const client = jest.fn(() => ({ chat: { completions: { create } } }));
jest.mock('openai', () => ({ __esModule: true, default: client }));
import { adviseWithToolPilot, escalateLoopGuard } from '../../src/services/toolPilot.js';
import type { LoopGuardAdvice } from '../../src/services/loopGuard.js';
const advice: LoopGuardAdvice = { trigger: 'repeated_identical_failure', resultIds: ['a','b','c'], recommendation: 'Review errors' };
const config = { enabled: true, baseUrl: 'http://localhost:1234/v1', model: 'diagnostic-model', apiKey: 'test' };
beforeEach(() => { create.mockReset(); client.mockClear(); });

test('does not call a model without a deterministic signal or explicit enablement', async () => {
  expect(await adviseWithToolPilot(null, { server: 'demo', tool: 'inspect' }, config)).toBeUndefined();
  expect(await adviseWithToolPilot(advice, { server: 'demo', tool: 'inspect' }, { ...config, enabled: false })).toBeUndefined();
  expect(client).not.toHaveBeenCalled();
});
test('returns bounded advice with separate internal model identity and no execution capability', async () => {
  create.mockResolvedValue({ model: 'reported-model', choices: [{ message: { content: 'Check the error and choose a different diagnostic tool.' } }] });
  const result = await adviseWithToolPilot(advice, { server: 'demo', tool: 'inspect', arguments: 'secret', raw: 'secret' } as any, config);
  expect(result).toMatchObject({ role: 'internal_toolpilot', model: 'diagnostic-model', reportedModel: 'reported-model', suggestion: expect.any(String) });
  const request = create.mock.calls[0][0];
  expect(JSON.stringify(request)).not.toContain('secret');
  expect(request.tools).toBeUndefined();
  expect(client.mock.calls[0][0]).toMatchObject({ maxRetries: 0, timeout: 3000 });
});
test('provider failure and empty output preserve deterministic advice', async () => {
  create.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });
  expect(await adviseWithToolPilot(advice, { server: 'demo', tool: 'inspect' }, config)).toBeUndefined();
  expect(await adviseWithToolPilot(advice, { server: 'demo', tool: 'inspect' }, config)).toBeUndefined();
});

test('backs off repeated warnings in one branch without suppressing other branches', async () => {
  create.mockResolvedValue({ choices: [{ message: { content: 'Review the errors.' } }] });
  const scope = { traceId: 'cooldown-test', branchId: 'a' };
  await escalateLoopGuard(advice, { server: 'demo', tool: 'inspect' }, scope, config);
  expect(await escalateLoopGuard(advice, { server: 'demo', tool: 'inspect' }, scope, config)).toBeUndefined();
  await escalateLoopGuard(advice, { server: 'demo', tool: 'inspect' }, { ...scope, branchId: 'b' }, config);
  expect(create).toHaveBeenCalledTimes(2);
});
