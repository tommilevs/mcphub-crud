const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockStatus = jest.fn();
const mockRestart = jest.fn();
const mockOverview = jest.fn();
jest.mock('../../src/services/nativeRuntimeOverview.js',()=>({getNativeRuntimeOverview:mockOverview}));

jest.mock('../../src/services/nativeRuntimeSecretService.js', () => ({
  putNativeRuntimeSecret: mockPut,
  deleteNativeRuntimeSecret: mockDelete,
  getNativeRuntimeStatus: mockStatus,
  restartNativeRuntimeProcess: mockRestart,
}));

import type { Request, Response } from 'express';
import { deleteSecret, getStatus, putSecret, restartProcess } from '../../src/controllers/nativeRuntimeController.js';

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

  it('restarts a valid managed process and rejects invalid ids', async () => {
    const invalid = response();
    await restartProcess({ params: { id: 'bad/id' } } as unknown as Request, invalid);
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(mockRestart).not.toHaveBeenCalled();

    mockRestart.mockResolvedValue({ id: 'desktop-commander', state: 'STARTING' });
    const res = response();
    await restartProcess({ params: { id: 'desktop-commander' } } as unknown as Request, res);
    expect(mockRestart).toHaveBeenCalledWith('desktop-commander');
    expect(res.json).toHaveBeenCalledWith({ data: { id: 'desktop-commander', state: 'STARTING' } });
  });
  it('targets an explicit interactive session for status and restart',async()=>{
    const execution={kind:'interactive',sessionId:7,pipeName:'mcphub-user-fixture'};
    mockStatus.mockResolvedValue({processes:[]});mockRestart.mockResolvedValue({ok:true});
    await getStatus({query:{sessionId:'7',pipeName:execution.pipeName}} as unknown as Request,response());
    expect(mockStatus).toHaveBeenCalledWith(execution);
    await restartProcess({params:{id:'fixture'},body:{executionContext:execution}} as unknown as Request,response());
    expect(mockRestart).toHaveBeenCalledWith('fixture',execution);
  });
  it('returns a configured-agent overview only when requested',async()=>{
    mockOverview.mockResolvedValue({processes:[],agents:[]});
    const res=response();
    await getStatus({query:{includeInteractive:'true'}} as unknown as Request,res);
    expect(mockOverview).toHaveBeenCalledTimes(1);expect(mockStatus).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({data:{processes:[],agents:[]}});
  });
  it('rejects invalid interactive targets before reaching the runtime',async()=>{
    const res=response();
    await getStatus({query:{sessionId:'0'}} as unknown as Request,res);
    expect(res.status).toHaveBeenCalledWith(400);expect(mockStatus).not.toHaveBeenCalled();
    const restart=response();
    await restartProcess({params:{id:'fixture'},body:{executionContext:{kind:'interactive',sessionId:0}}} as unknown as Request,restart);
    expect(restart.status).toHaveBeenCalledWith(400);expect(mockRestart).not.toHaveBeenCalled();
  });
});
