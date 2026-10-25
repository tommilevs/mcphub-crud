jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: jest.fn() }));
import { verifyAcquisitionOperation } from '../../src/services/mcpAcquisitionVerification.js';

function fixture() {
  return {
    repository: { beginVerification: jest.fn(async () => ({ claim_id: 'claim', manifest: { serverName: 'fixture' } })),
      recordInspection: jest.fn(async () => true), requireReconciliation: jest.fn(async () => true),
      transition: jest.fn(async () => ({ state: 'failed' })) },
    inspect: jest.fn(async () => ({ verification: 'functional' as const,
      tools: [{ name: 'fixture_ping', description: 'Do not retain this metadata here', inputSchema: {} }],
      probe: { tool: 'fixture_ping', resultId: 'result' } })),
  };
}
test('stores only the inspection receipt and never marks publication ready', async () => {
  const dependencies = fixture();
  const result = await verifyAcquisitionOperation('alice', 'operation', {}, dependencies);
  expect(result).toEqual({ status: 'inspected', verification: 'functional' });
  expect(dependencies.repository.recordInspection).toHaveBeenCalledWith('alice', 'operation', 'claim', {
    verification: 'functional', tools: ['fixture_ping'], resultId: 'result',
  });
  expect(dependencies.repository.transition).not.toHaveBeenCalled();
});
test('a duplicate continuation never reinitializes a server or repeats a probe', async () => {
  const dependencies = fixture(); dependencies.repository.beginVerification.mockResolvedValue(null as any);
  expect((await verifyAcquisitionOperation('alice', 'operation', {}, dependencies)).status).toBe('not_claimed');
  expect(dependencies.inspect).not.toHaveBeenCalled();
});
test('failed evidence persistence requires reconciliation rather than a blind retry', async () => {
  const dependencies = fixture(); dependencies.repository.recordInspection.mockResolvedValue(false);
  expect((await verifyAcquisitionOperation('alice', 'operation', {}, dependencies)).status).toBe('reconciliation_required');
  expect(dependencies.repository.requireReconciliation).toHaveBeenCalled();
});
