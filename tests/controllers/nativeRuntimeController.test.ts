const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockStatus = jest.fn();

jest.mock('../../src/services/nativeRuntimeSecretService.js', () => ({
  putNativeRuntimeSecret: mockPut,
  deleteNativeRuntimeSecret: mockDelete,
  getNativeRuntimeStatus: mockStatus,
}));

import type { Request, Response } from 'express';
import { deleteSecret, getStatus, putSecret } from '../../src/controllers/nativeRuntimeController.js';

const response = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  return res as Response;
};

describe('nativeRuntimeController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects invalid secret input before contacting the runtime', async () => {
    const res = response();
    await putSecret({ params: { id: 'bad/id' }, body: { value: 'secret' } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('enrolls and deletes a valid secret', async () => {
    mockPut.mockResolvedValue({ ok: true });
    mockDelete.mockResolvedValue({ ok: true });
    const putRes = response();
    await putSecret({ params: { id: 'github-token' }, body: { value: 'secret' } } as unknown as Request, putRes);
    expect(mockPut).toHaveBeenCalledWith('github-token', 'secret');
    expect(putRes.status).toHaveBeenCalledWith(204);
    expect(putRes.end).toHaveBeenCalled();

    const deleteRes = response();
    await deleteSecret({ params: { id: 'github-token' } } as unknown as Request, deleteRes);
    expect(mockDelete).toHaveBeenCalledWith('github-token');
    expect(deleteRes.status).toHaveBeenCalledWith(204);
  });

  it('returns runtime status and maps service failures to 503', async () => {
    mockStatus.mockResolvedValue([{ id: 'desktop-commander', running: true, restarts: 0 }]);
    const res = response();
    await getStatus({} as Request, res);
    expect(res.json).toHaveBeenCalledWith({ data: [{ id: 'desktop-commander', running: true, restarts: 0 }] });

    mockStatus.mockRejectedValue(new Error('offline'));
    const failed = response();
    await getStatus({} as Request, failed);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(failed.json).toHaveBeenCalledWith({ error: 'offline' });
  });
});
