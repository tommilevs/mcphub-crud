import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { ToolResultHistoryService, type ToolResultRepository } from './toolResultHistoryService.js';

const repository = (): jest.Mocked<ToolResultRepository> => ({
  create: jest.fn(async (record) => record),
  enforceRetention: jest.fn(async () => 0),
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
  it('stores immutable RAW metadata and enforces retention', async () => {
    const repo = repository();
    const service = new ToolResultHistoryService(repo, { recentLimit: 42 });
    const result = { content: [{ type: 'text', text: 'hello 🌍' }] };

    const saved = await service.capture({
      server: 'demo',
      tool: 'echo',
      durationMs: 12,
      status: 'success',
      username: 'alice',
      sessionId: 'session-1',
      result,
      arguments: { value: 'hello' },
    });

    const raw = JSON.stringify(result);
    expect(saved?.resultId).toEqual(expect.any(String));
    expect(saved?.raw).toBe(raw);
    expect(saved?.rawBytes).toBe(Buffer.byteLength(raw));
    expect(saved?.rawSha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(saved?.rawText).toBe('hello 🌍');
    expect(repo.enforceRetention).toHaveBeenCalledWith(42, 'alice');
  });

  it('omits sensitive payloads while preserving an explicit reason', async () => {
    const repo = repository();
    const service = new ToolResultHistoryService(repo);

    const saved = await service.capture({
      server: 'private',
      tool: 'login',
      durationMs: 3,
      status: 'success',
      result: { token: 'secret' },
      capturePayload: false,
      payloadOmissionReason: 'personal authentication policy',
    });

    expect(saved).toMatchObject({
      raw: null,
      rawText: null,
      rawBytes: 0,
      rawSha256: null,
      payloadAvailable: false,
      payloadOmissionReason: 'personal authentication policy',
    });
  });

  it('returns UTF-8 byte ranges and rejects invalid boundaries', () => {
    const service = new ToolResultHistoryService(repository());
    const raw = 'A🌍B';
    const bytes = Buffer.from(raw, 'utf8');

    expect(service.getByteRange(raw, 1, 5).toString('utf8')).toBe('🌍');
    expect(() => service.getByteRange(raw, -1, 2)).toThrow(RangeError);
    expect(() => service.getByteRange(raw, 0, bytes.length + 1)).toThrow(RangeError);
  });
});
