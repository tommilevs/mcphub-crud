import type { Request, Response } from 'express';
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

export const getStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    const status = await getNativeRuntimeStatus();
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
  try {
    const status = await restartNativeRuntimeProcess(id);
    res.json({ data: status });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Native runtime unavailable' });
  }
};
