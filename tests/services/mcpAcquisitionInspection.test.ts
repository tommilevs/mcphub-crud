import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { AcquisitionManifest } from '../../src/services/mcpAcquisitionPlan.js';
import { acquisitionManifestDigest } from '../../src/services/mcpAcquisitionPlan.js';
const mockResolve = jest.fn();
const mockDbQuery = jest.fn();
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query: mockDbQuery }) }));
jest.mock('../../src/services/nativeRuntimeSecretService.js', () => ({
  resolveNativeInstalledPackage: (...args: unknown[]) => mockResolve(...args),
}));
import { inspectAcquiredMcp } from '../../src/services/mcpAcquisitionInspection.js';

const suite = process.platform === 'win32' ? describe : describe.skip;
suite('MCP acquisition SDK discovery through native transport', () => {
  let server: net.Server;
  let sockets: net.Socket[];
  let previous: string | undefined;
  let methods: string[];
  let stopped: boolean;
  const manifest: AcquisitionManifest = { schemaVersion: 1, serverName: 'fixture', targetGroup: 'group',
    transport: 'stdio', package: { ecosystem: 'npm', name: '@fixture/mcp', version: '1.2.3' },
    source: { type: 'local_catalog', repository: null }, requiredInputs: [] };
  beforeEach(async () => {
    previous = process.env.MCPHUB_NATIVE_PIPE;
    const pipe = `\\\\.\\pipe\\mcphub-inspection-${randomUUID()}`;
    process.env.MCPHUB_NATIVE_PIPE = pipe;
    sockets = []; methods = []; stopped = false;
    mockResolve.mockReset();
    mockDbQuery.mockReset();
    mockResolve.mockResolvedValue({ verification: 'package_metadata', package: manifest.package,
      spec: { command: 'fixture-node.exe', cwd: 'C:\\fixture', args: ['main.js'] } });
    server = net.createServer(socket => {
      sockets.push(socket); let buffer = '';
      socket.on('error', () => {});
      socket.on('data', chunk => {
        buffer += chunk.toString(); let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
          let response: object = { ok: true };
          if (request.op === 'status') response = { workingDirectory: true };
          if (request.op === 'stop') stopped = true;
          if (request.op === 'stdio') {
            const message = JSON.parse(request.message); methods.push(message.method);
            const result = message.method === 'initialize'
              ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
              : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'synthetic-probe-response' }] }
              : { tools: [{ name: 'fixture_ping', inputSchema: { type: 'object' } }] };
            response = { responses: message.id === undefined ? [] : [JSON.stringify({ jsonrpc: '2.0', id: message.id, result })] };
          }
          socket.write(JSON.stringify(response) + '\n');
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  });
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.MCPHUB_NATIVE_PIPE; else process.env.MCPHUB_NATIVE_PIPE = previous;
  });
  test('initializes, enumerates and closes without calling tools or claiming functional verification', async () => {
    const result = await inspectAcquiredMcp(randomUUID(), manifest);
    expect(result.verification).toBe('discovery_only');
    expect(result.tools.map(tool => tool.name)).toEqual(['fixture_ping']);
    expect(methods).toContain('initialize'); expect(methods).toContain('tools/list');
    expect(methods).not.toContain('tools/call'); expect(stopped).toBe(true);
  });
  test('missing required configuration rejects before resolution or spawning', async () => {
    await expect(inspectAcquiredMcp(randomUUID(), { ...manifest, requiredInputs: ['TOKEN'] })).rejects.toThrow('Required');
    expect(mockResolve).not.toHaveBeenCalled(); expect(sockets).toHaveLength(0);
  });
  test('calls only the exact authorized probe and retains owner-scoped RAW before returning evidence', async () => {
    const plan = { ...manifest, probe: { tool: 'fixture_ping' } };
    mockDbQuery.mockImplementation(async (sql, args) => {
      if (sql.includes('SELECT p.manifest')) return [{ manifest: plan, manifest_digest: acquisitionManifestDigest(plan) }];
      if (sql.includes('RETURNING probe_claim_id')) return [{ probe_claim_id: args[2] }];
      return [{ operation_id: args[0] }];
    });
    const resultId = randomUUID();
    const capture = jest.fn(async () => ({ resultId, payloadAvailable: true } as any));
    const result = await inspectAcquiredMcp(randomUUID(), plan, {}, { username: 'alice', history: { capture } });
    expect(result).toMatchObject({ verification: 'functional', probe: { tool: 'fixture_ping', resultId } });
    expect(methods.filter(method => method === 'tools/call')).toHaveLength(1);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice', arguments: {}, capturePayload: true,
      result: { content: [{ type: 'text', text: 'synthetic-probe-response' }] } }));
    expect(JSON.stringify(result)).not.toContain('synthetic-probe-response');
    expect(stopped).toBe(true);
  });
  test('probe permission cannot be supplied by an unapproved manifest', async () => {
    mockDbQuery.mockResolvedValue([]);
    await expect(inspectAcquiredMcp(randomUUID(), { ...manifest, probe: { tool: 'fixture_ping' } }, {},
      { username: 'alice' })).rejects.toThrow('not authorized');
    expect(mockResolve).not.toHaveBeenCalled(); expect(sockets).toHaveLength(0);
  });
  test('an already-started probe is never replayed even when its native outcome is unknown', async () => {
    const plan = { ...manifest, probe: { tool: 'fixture_ping' } };
    mockDbQuery.mockImplementation(async (sql) => sql.includes('SELECT p.manifest')
      ? [{ manifest: plan, manifest_digest: acquisitionManifestDigest(plan) }] : []);
    const capture = jest.fn();
    await expect(inspectAcquiredMcp(randomUUID(), plan, {}, { username: 'alice', history: { capture } }))
      .rejects.toThrow('already started');
    expect(methods).not.toContain('tools/call'); expect(capture).not.toHaveBeenCalled();
    expect(stopped).toBe(true);
  });
});
