import type { Request, Response } from 'express';

jest.mock('../../src/services/cloudService.js', () => ({
  callCloudServerTool: jest.fn(),
}));
jest.mock('../../src/services/toolResultHistoryCoordinator.js', () => ({
  getToolResultHistoryCoordinator: jest.fn(),
}));

import { callCloudTool } from '../../src/controllers/cloudController.js';
import { callCloudServerTool } from '../../src/services/cloudService.js';
import { getToolResultHistoryCoordinator } from '../../src/services/toolResultHistoryCoordinator.js';

describe('callCloudTool', () => {
  it('persists the canonical cloud result before returning it', async () => {
    const result = { content: [{ type: 'text', text: 'completed' }], isError: false };
    const captureAndAnnotate = jest.fn().mockResolvedValue({
      ...result,
      _meta: { 'mcphub/result_id': 'result-id' },
    });
    jest.mocked(callCloudServerTool).mockResolvedValue(result);
    jest.mocked(getToolResultHistoryCoordinator).mockReturnValue({ captureAndAnnotate } as never);
    const req = {
      params: { serverName: 'cloud-server', toolName: 'lookup' },
      body: { arguments: { query: 'test' } },
      headers: { 'x-session-id': 'session-1' },
      user: { username: 'tommi' },
    } as unknown as Request;
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response;

    await callCloudTool(req, res);

    expect(captureAndAnnotate).toHaveBeenCalledWith(result, expect.objectContaining({
      server: 'cloud-server',
      tool: 'lookup',
      arguments: { query: 'test' },
      username: 'tommi',
      sessionId: 'session-1',
      status: 'success',
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({ _meta: { 'mcphub/result_id': 'result-id' } }),
    });
  });

  it('records a failed cloud invocation before returning its error', async () => {
    const captureAndAnnotate = jest.fn().mockResolvedValue(undefined);
    jest.mocked(callCloudServerTool).mockRejectedValue(new Error('upstream unavailable'));
    jest.mocked(getToolResultHistoryCoordinator).mockReturnValue({ captureAndAnnotate } as never);
    const req = {
      params: { serverName: 'cloud-server', toolName: 'lookup' },
      body: { arguments: { query: 'test' } },
      headers: {},
      user: { username: 'tommi' },
    } as unknown as Request;
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response;

    await callCloudTool(req, res);

    expect(captureAndAnnotate).toHaveBeenCalledWith(expect.objectContaining({
      isError: true,
      content: [{ type: 'text', text: 'upstream unavailable' }],
    }), expect.objectContaining({
      server: 'cloud-server',
      tool: 'lookup',
      status: 'error',
      username: 'tommi',
    }));
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
