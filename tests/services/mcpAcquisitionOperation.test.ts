import { AcquisitionOperationRepository, canTransitionAcquisition } from '../../src/services/mcpAcquisitionOperation.js';

test('execution progresses in order and terminal outcomes cannot restart', () => {
  expect(canTransitionAcquisition('staging', 'starting')).toBe(true);
  expect(canTransitionAcquisition('starting', 'verifying')).toBe(true);
  expect(canTransitionAcquisition('verifying', 'ready')).toBe(true);
  expect(canTransitionAcquisition('staging', 'ready')).toBe(false);
  for (const state of ['ready', 'cancelled', 'rolled_back']) {
    expect(canTransitionAcquisition(state, 'staging')).toBe(false);
  }
  expect(canTransitionAcquisition('failed', 'rolled_back')).toBe(true);
});

test('publication rejects a mismatched operation receipt before reaching the database', async () => {
  const query = jest.fn();
  const repository = new AcquisitionOperationRepository({ query });
  await expect(repository.reservePublication('alice', 'a5ed66f5-a21e-4acd-85d9-b1dbbfe120dc',
    'b5ed66f5-a21e-4acd-85d9-b1dbbfe120dc', { storage: 'json', settingsPath: 'settings.json',
      baseDigest: 'a'.repeat(64), receipt: { operationId: 'another-operation' } } as any)).rejects.toThrow('Invalid publication');
  expect(query).not.toHaveBeenCalled();
});
