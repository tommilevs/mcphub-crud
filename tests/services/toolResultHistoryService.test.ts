import { createHash } from 'node:crypto';
import {
  ToolResultHistoryService,
  type ToolResultRepository,
} from '../../src/services/toolResultHistoryService.js';
import type { ToolResultRecord } from '../../src/types/toolResult.js';

const createRepository = (): jest.Mocked<ToolResultRepository> => ({
  create: jest.fn(),
  enforceRetention: jest.fn(),
  findById: jest.fn(),
  findPaginated: jest.fn(),
  findForReindex: jest.fn(),
  countForReindex: jest.fn(),
  search: jest.fn(),
  setPinned: jest.fn(),
  incrementUseCount: jest.fn(),
  getStats: jest.fn(),
});

describe('ToolResultHistoryService', () => {
  it('persists an immutable canonical RAW envelope and enforces retention', async () => {
    const repository = createRepository();
    repository.create.mockImplementation(async (record) => record as ToolResultRecord);
    const service = new ToolResultHistoryService(repository, { recentLimit: 10_000 });
    const result = {
      content: [{ type: 'text', text: 'GPU Xid 79\nsecond line' }],
      structuredContent: { exitCode: 1 },
      isError: true,
    };

    const saved = await service.capture({
      server: 'desktop-commander',
      tool: 'read_process_output',
      durationMs: 42,
      status: 'error',
      arguments: { pid: 7 },
      result,
      group: 'infra',
      username: 'tommi',
    });

    const raw = JSON.stringify(result);
    expect(saved?.resultId).toMatch(/^[0-9a-f-]{36}$/);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        raw,
        rawBytes: Buffer.byteLength(raw),
        rawSha256: createHash('sha256').update(raw).digest('hex'),
        payloadAvailable: true,
        arguments: JSON.stringify({ pid: 7 }),
      }),
    );
    expect(repository.enforceRetention).toHaveBeenCalledWith(10_000, 'tommi');
  });

  it('stores metadata only when payload capture is prohibited', async () => {
    const repository = createRepository();
    repository.create.mockImplementation(async (record) => record as ToolResultRecord);
    const service = new ToolResultHistoryService(repository);

    await service.capture({
      server: 'private-server',
      tool: 'read_secret',
      durationMs: 5,
      status: 'success',
      arguments: { key: 'secret-name' },
      result: { content: [{ type: 'text', text: 'must not persist' }] },
      username: 'tommi',
      capturePayload: false,
      payloadOmissionReason: 'credential-templated server',
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: null,
        arguments: null,
        rawBytes: 0,
        rawSha256: null,
        payloadAvailable: false,
        payloadOmissionReason: 'credential-templated server',
      }),
    );
  });

  it('returns UTF-8 byte ranges and rejects invalid boundaries', () => {
    const service = new ToolResultHistoryService(createRepository());
    const raw = 'A🙂B';

    expect(service.getByteRange(raw, 1, 5).toString('utf8')).toBe('🙂');
    expect(() => service.getByteRange(raw, 5, 1)).toThrow('Invalid byte range');
    expect(() => service.getByteRange(raw, 0, 99)).toThrow('Invalid byte range');
  });
});
