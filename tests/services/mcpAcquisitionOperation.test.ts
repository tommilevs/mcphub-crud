import { canTransitionAcquisition } from '../../src/services/mcpAcquisitionOperation.js';

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
