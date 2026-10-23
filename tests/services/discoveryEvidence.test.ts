import { extractDiscoveryEvidence } from '../../src/services/discoveryEvidence.js';

test('records visible candidate names and schema fingerprints without search text or descriptions', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify({ tools: [
    { name: 'demo-inspect', inputSchema: { type: 'object', properties: {} }, description: 'private description' },
    { name: 'demo-read' },
  ], metadata: { query: 'private objective' } }) }] };
  const evidence = extractDiscoveryEvidence('search_tools', result);
  expect(evidence?.candidates).toHaveLength(2);
  expect(evidence?.candidates[0].schemaSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(evidence?.candidates[1].schemaSha256).toBeNull();
  expect(JSON.stringify(evidence)).not.toMatch(/private|properties/);
});

test('ignores execution responses and unsuccessful discovery', () => {
  expect(extractDiscoveryEvidence('call_tool', { content: [] })).toBeNull();
  expect(extractDiscoveryEvidence('describe_tool', { isError: true })).toBeNull();
});
