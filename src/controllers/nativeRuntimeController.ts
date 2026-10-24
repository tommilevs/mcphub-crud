import type { Request, Response } from 'express';
import { normalizeNativeExecution } from '../utils/nativeExecution.js';
import type { NativeExecution } from '../types/index.js';
import {
  deleteNativeRuntimeSecret,
  putNativeRuntimeSecret,
  getNativeRuntimeStatus,
  restartNativeRuntimeProcess,
} from '../services/nativeRuntimeSecretService.js';

const SECRET_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export const putSecret = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || '');
  const value = req.body?.value;
  if (!SECRET_ID.test(id) || typeof value !== 'string' || value.length > 64 * 1024) {
    res.status(400).json({ error: 'Invalid secret id or value' });
    return;
  }
  try {
    await putNativeRuntimeSecret(id, value);
    res.status(204).end();
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Native runtime unavailable' });
  }
};

export const deleteSecret = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || '');
  if (!SECRET_ID.test(id)) {
    res.status(400).json({ error: 'Invalid secret id' });
    return;
  }
  try {
    await deleteNativeRuntimeSecret(id);
    res.status(204).end();
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Native runtime unavailable' });
  }
};

export const getStatus = async (req: Request, res: Response): Promise<void> => {
  let execution:NativeExecution|undefined;
  try {
    if(req.query?.sessionId!==undefined||req.query?.pipeName!==undefined){
      const session=req.query.sessionId;
      if(typeof session!=='string'||!/^\d+$/.test(session))throw new Error('Invalid Windows session id');
      execution=normalizeNativeExecution({kind:'interactive',sessionId:Number(session),...(req.query.pipeName!==undefined?{pipeName:req.query.pipeName}:{})});
    }
  }catch(error){res.status(400).json({error:error instanceof Error?error.message:'Invalid execution context'});return;}
  try {
    const status = await (execution?getNativeRuntimeStatus(execution):getNativeRuntimeStatus());
    res.json({ data: status });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Native runtime unavailable' });
  }
};

export const restartProcess = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || '');
  if (!SECRET_ID.test(id)) {
    res.status(400).json({ error: 'Invalid process id' });
    return;
  }
  let execution:NativeExecution|undefined;
  try{execution=normalizeNativeExecution(req.body?.executionContext);}
  catch(error){res.status(400).json({error:error instanceof Error?error.message:'Invalid execution context'});return;}
  try {
    const status = await (execution?restartNativeRuntimeProcess(id,execution):restartNativeRuntimeProcess(id));
    res.json({ data: status });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Native runtime unavailable' });
  }
};
