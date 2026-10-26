import { cleanupAcquisitionRuntime } from '../../src/services/mcpAcquisitionRollback.js';

const mockGetServer = jest.fn();
const mockClose = jest.fn();
const mockNotify = jest.fn();
jest.mock('../../src/services/mcpService.js', () => ({
  getServerByName: (...args: unknown[]) => mockGetServer(...args),
  closeServer: (...args: unknown[]) => mockClose(...args),
  notifyToolChanged: (...args: unknown[]) => mockNotify(...args),
}));
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: jest.fn() }));

const receipt = {serverName:'fixture',operationId:'operation',server:{owner:'alice'}} as any;
beforeEach(() => jest.clearAllMocks());

test.each(['spawn', 'transport', 'client'])('refuses a replacement runtime after awaiting %s', async (phase) => {
  let current: any;
  const replace = async () => { current = {config:{owner:'bob'}}; };
  const transportClose = jest.fn(phase === 'transport' ? replace : async () => undefined);
  const clientClose = jest.fn(phase === 'client' ? replace : async () => undefined);
  current = {config:{owner:'alice',options:{acquisitionOperationId:'operation'}},
    transport:{close:transportClose},client:{close:clientClose}};
  if (phase === 'spawn') current.spawningPromise = new Promise<void>((resolve) => {
    setImmediate(() => { void replace().then(resolve); });
  });
  mockGetServer.mockImplementation(() => current);
  await expect(cleanupAcquisitionRuntime(receipt)).rejects.toThrow('ownership changed');
  expect(mockClose).not.toHaveBeenCalled();
  expect(mockNotify).not.toHaveBeenCalled();
  if (phase === 'spawn') expect(transportClose).not.toHaveBeenCalled();
  if (phase === 'transport') expect(clientClose).not.toHaveBeenCalled();
});
