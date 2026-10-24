import {
  ToolResultHistoryCoordinator,
  chunkToolResultText,
  TOOL_RESULT_CHUNK_CHARS,
  type ToolResultHistoryCapture,
} from '../../src/services/toolResultHistoryCoordinator.js';
import type { ToolResultHistoryService } from '../../src/services/toolResultHistoryService.js';

describe('ToolResultHistoryCoordinator', () => {
  it('chunks long evidence without rewriting its text', () => {
    const source = `first line\n${'x'.repeat(TOOL_RESULT_CHUNK_CHARS + 3)}\nlast line`;
    const chunks = chunkToolResultText(source);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join('\n')).toContain('first line');
    expect(chunks.join('')).toContain('last line');
    expect(chunks.every((chunk) => chunk.length <= TOOL_RESULT_CHUNK_CHARS)).toBe(true);
  });

  it('preserves blank lines, line endings and Unicode at chunk boundaries', () => {
    const source = '\n\nalpha\r\n\n12345\u{1F600}tail\n';
    const chunks = chunkToolResultText(source, 6);
    expect(chunks.join('')).toBe(source);
    expect(chunks.every(chunk => chunk.length <= 6)).toBe(true);
    for (const chunk of chunks) {
      expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk);
    }
  });

  it.each([0, 1, -1, 1.5, NaN, Infinity])('rejects invalid chunk size %s', size => {
    expect(() => chunkToolResultText('evidence', size)).toThrow(RangeError);
  });

  it('adds a namespaced result id while preserving existing MCP metadata', async () => {
    const history = {
      capture: jest.fn().mockResolvedValue({ resultId: '165a2c4c-3ad6-46ab-b547-8e4bf10d934d' }),
    } as unknown as ToolResultHistoryService;
    const coordinator = new ToolResultHistoryCoordinator(() => history);
    const result = {
      content: [{ type: 'text', text: 'ok' }],
      _meta: { existing: true },
    };

    const annotated = await coordinator.captureAndAnnotate(result, {
      server: 'server',
      tool: 'tool',
      durationMs: 4,
      status: 'success',
      arguments: {},
    });

    expect(annotated).toEqual({
      ...result,
      _meta: {
        existing: true,
        'mcphub/result_id': '165a2c4c-3ad6-46ab-b547-8e4bf10d934d',
      },
    });
    expect(history.capture).toHaveBeenCalledWith(expect.objectContaining({ result }));
  });

  it('fails open without changing the tool result', async () => {
    const history = {
      capture: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as ToolResultHistoryService;
    const coordinator = new ToolResultHistoryCoordinator(() => history);
    const result = { content: [{ type: 'text', text: 'valuable output' }] };

    await expect(
      coordinator.captureAndAnnotate(result, {
        server: 'server',
        tool: 'tool',
        durationMs: 4,
        status: 'success',
      }),
    ).resolves.toBe(result);
  });

  it('passes metadata-only capture policy for personal authentication', async () => {
    const capture = jest.fn().mockResolvedValue({ resultId: 'id' });
    const coordinator = new ToolResultHistoryCoordinator(
      () => ({ capture } as unknown as ToolResultHistoryService),
    );
    const metadata: ToolResultHistoryCapture = {
      server: 'server',
      tool: 'tool',
      durationMs: 4,
      status: 'success',
      sensitive: true,
    };

    await coordinator.captureAndAnnotate({ content: [] }, metadata);

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        capturePayload: false,
        payloadOmissionReason: 'personal authentication policy',
      }),
    );
  });
});
