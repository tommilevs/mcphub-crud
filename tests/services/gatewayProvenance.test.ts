import { createGatewayProof, verifyGatewayProof } from '../../src/services/gatewayProvenance.js';
const secret = 'fixture-secret-long-enough-for-test';
const request = { id: 42, params: { name: 'call_tool', arguments: { toolName: 'demo', arguments: { x: 1 } } } };
const response = { id: 'response-1', model: 'observed-model', choices: [{ message: { tool_calls: [
  { id: 'call-1', type: 'function', function: { name: 'call_tool', arguments: JSON.stringify(request.params.arguments) } },
] } }] };
const now = 100000;
const sign = () => createGatewayProof(response, 'call-1', request, { adapterId: 'trusted-gateway', principal: 'owner', secret, now });
test('binds an actual response tool call to an invocation and authenticated owner', async () => {
  const proof = sign();
  const consume = jest.fn(async () => true);
  expect(await verifyGatewayProof(proof, request, 'owner', () => secret, consume, now)).toMatchObject({
    modelId: 'observed-model', responseId: 'response-1', toolCallId: 'call-1', adapterId: 'trusted-gateway',
  });
  expect(consume).toHaveBeenCalledTimes(1);
});
test('refuses fabricated tool-call relationships and ambiguous response entries', () => {
  expect(() => createGatewayProof(response, 'missing', request, { adapterId: 'a', principal: 'owner', secret, now })).toThrow();
  expect(() => createGatewayProof(response, 'call-1', { ...request, params: { ...request.params, arguments: {} } }, { adapterId: 'a', principal: 'owner', secret, now })).toThrow();
  const duplicate = { ...response, choices: [response.choices[0],response.choices[0]] };
  expect(() => createGatewayProof(duplicate, 'call-1', request, { adapterId: 'a', principal: 'owner', secret, now })).toThrow();
});
test('rejects tampering, wrong owner, changed invocation, expiry and replay before trust', async () => {
  const proof = sign();
  for (const [candidate, invocation, owner, time] of [
    [{ ...proof, modelId: 'guessed' }, request, 'owner', now],
    [proof, request, 'other-owner', now],
    [proof, { ...request, id: 43 }, 'owner', now],
    [proof, request, 'owner', now + 61000],
    [proof, request, 'owner', now - 6000],
  ] as const) {
    const consume = jest.fn(async () => true);
    expect(await verifyGatewayProof(candidate, invocation, owner, () => secret, consume, time)).toBeNull();
    expect(consume).not.toHaveBeenCalled();
  }
  expect(await verifyGatewayProof(proof, request, 'owner', () => undefined, async () => true, now)).toBeNull();
  expect(await verifyGatewayProof(proof, request, 'owner', () => secret, async () => false, now)).toBeNull();
});
