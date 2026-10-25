jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: jest.fn() }));
import { stageAcquisitionPackage } from '../../src/services/mcpAcquisitionInstaller.js';

function fixture() {
  const manifest = { package: { name: '@fixture/mcp', version: '1.2.3' } };
  const operation = { state: 'staging', cancel_requested: false };
  const repository = {
    claim: jest.fn(async () => ({ claim_id: 'claim', manifest })),
    get: jest.fn(async () => operation),
    transition: jest.fn(async (_owner, _id, _claim, _from, to) => { operation.state = to; return operation; }),
    requireReconciliation: jest.fn(async () => true),
  };
  const native = { start: jest.fn(async () => ({ state: 'running' })),
    status: jest.fn(async () => ({ state: 'exited', exitCode: 0 })),
    cancel: jest.fn(async () => ({ cancelRequested: true })),
  };
  return { repository, native, operation, sleep: jest.fn(async () => {}), now: () => 0 };
}

test('only a claimed operation starts one pinned package and stops before tool publication', async () => {
  const dependencies = fixture();
  const result = await stageAcquisitionPackage('alice', 'operation', dependencies);
  expect(result.status).toBe('package_staged');
  expect(dependencies.native.start).toHaveBeenCalledTimes(1);
  expect(dependencies.native.start).toHaveBeenCalledWith('operation', '@fixture/mcp', '1.2.3');
  expect(dependencies.operation.state).toBe('starting');
});

test('a competing or already claimed operation never starts an installer', async () => {
  const dependencies = fixture();
  dependencies.repository.claim.mockResolvedValue(null as any);
  expect((await stageAcquisitionPackage('alice', 'operation', dependencies)).status).toBe('not_claimed');
  expect(dependencies.native.start).not.toHaveBeenCalled();
});

test('an uncertain start response requires reconciliation without automatic replay or cleanup', async () => {
  const dependencies = fixture();
  dependencies.native.start.mockRejectedValue(new Error('private diagnostic'));
  const result = await stageAcquisitionPackage('alice', 'operation', dependencies);
  expect(result.status).toBe('reconciliation_required');
  expect(JSON.stringify(result)).not.toContain('private diagnostic');
  expect(dependencies.repository.requireReconciliation).toHaveBeenCalled();
  expect(dependencies.repository.transition).not.toHaveBeenCalled();
});

test('cancellation waits for native termination and retains failed staging for cleanup', async () => {
  const dependencies = fixture();
  dependencies.native.start.mockImplementation(async () => {
    dependencies.operation.cancel_requested = true; return { state: 'running' };
  });
  dependencies.native.status.mockResolvedValue({ state: 'cancelled' } as any);
  const result = await stageAcquisitionPackage('alice', 'operation', dependencies);
  expect(dependencies.native.cancel).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ status: 'failed', reason: 'cancelled_requires_cleanup' });
  expect(dependencies.operation.state).toBe('failed');
});

test('an installer error exit cannot proceed to starting or ready', async () => {
  const dependencies = fixture();
  dependencies.native.status.mockResolvedValue({ state: 'exited', exitCode: 7 });
  const result = await stageAcquisitionPackage('alice', 'operation', dependencies);
  expect(result).toMatchObject({ status: 'failed', reason: 'installer_failed' });
  expect(dependencies.operation.state).toBe('failed');
});

test('an unknown native status is not interpreted as a stopped or successful installer', async () => {
  const dependencies = fixture();
  dependencies.native.status.mockResolvedValue({ state: 'unknown' } as any);
  expect((await stageAcquisitionPackage('alice', 'operation', dependencies)).status).toBe('reconciliation_required');
  expect(dependencies.repository.transition).not.toHaveBeenCalled();
});
