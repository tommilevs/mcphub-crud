import type { Request, Response } from 'express';
import { loadSettings } from '../config/configManager.js';
import { getMarketServers } from '../services/marketService.js';
import { AcquisitionInputError, proposeMcpServers } from '../services/mcpAcquisitionService.js';
import { getAppDataSource } from '../db/connection.js';
import { AcquisitionPlanRepository, buildAcquisitionManifest } from '../services/mcpAcquisitionPlan.js';
import { AcquisitionOperationRepository } from '../services/mcpAcquisitionOperation.js';
import { enqueueAcquisitionExecution } from '../services/mcpAcquisitionExecutionQueue.js';
import { AcquisitionExecutionUnavailable } from '../services/mcpAcquisitionExecution.js';

/** Admin route: complete configured names are used only for duplicate exclusion. */
export async function proposeMcpAcquisition(req: Request, res: Response): Promise<void> {
  try {
    const { objective, limit = 3 } = req.body ?? {};
    // Validate before accessing settings or catalog.
    proposeMcpServers(objective, [], [], limit);
    const settings = await loadSettings();
    const data = proposeMcpServers(objective, Object.values(getMarketServers()),
      Object.keys(settings.mcpServers ?? {}), limit);
    res.json({ success: true, data });
  } catch (error) {
    if (error instanceof AcquisitionInputError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Unable to prepare MCP server proposals' });
  }
}

function ownerOf(req: Request): string | null {
  const username = (req as any).user?.username;
  return typeof username === 'string' && username.trim() && username.length <= 255 ? username : null;
}

export async function createMcpAcquisitionPlan(req: Request, res: Response): Promise<void> {
  const owner = ownerOf(req);
  if (!owner) { res.status(401).json({ success: false, message: 'Authenticated owner is required' }); return; }
  const { serverName, version, targetGroup, probeTool } = req.body ?? {};
  if ([serverName, version, targetGroup].some(value => typeof value !== 'string' || !value.trim() || value.length > 255)) {
    res.status(400).json({ success: false, message: 'Server, exact version and target group are required' }); return;
  }
  try {
    const settings = await loadSettings();
    if (!settings.groups?.some(group => group.id === targetGroup)) {
      res.status(404).json({ success: false, message: 'Target group is unavailable' }); return;
    }
    if (Object.keys(settings.mcpServers ?? {}).some(name => name.toLowerCase() === serverName.toLowerCase())) {
      res.status(409).json({ success: false, message: 'Server is already configured' }); return;
    }
    const server = getMarketServers()[serverName];
    if (!server) { res.status(404).json({ success: false, message: 'Catalog server is unavailable' }); return; }
    const manifest = buildAcquisitionManifest(server, version, targetGroup, probeTool);
    const plan = await new AcquisitionPlanRepository(getAppDataSource()).create(owner, manifest);
    res.status(201).json({ success: true, data: { ...plan, status: 'proposed', verification: 'catalog_only' } });
  } catch (error) {
    if (error instanceof AcquisitionInputError) {
      res.status(400).json({ success: false, message: error.message }); return;
    }
    res.status(503).json({ success: false, message: 'Acquisition plan storage is unavailable' });
  }
}

export async function getMcpAcquisitionPlan(req: Request, res: Response): Promise<void> {
  const owner = ownerOf(req);
  if (!owner) { res.status(401).json({ success: false, message: 'Authenticated owner is required' }); return; }
  try {
    const plan = await new AcquisitionPlanRepository(getAppDataSource()).get(owner, req.params.id as string);
    if (!plan) { res.status(404).json({ success: false, message: 'Plan is unavailable or expired' }); return; }
    res.json({ success: true, data: { ...plan, status: plan.operation_state ?? 'proposed', verification: 'catalog_only' } });
  } catch (error) {
    if (error instanceof AcquisitionInputError) {
      res.status(400).json({ success: false, message: error.message }); return;
    }
    res.status(503).json({ success: false, message: 'Acquisition plan storage is unavailable' });
  }
}

export async function authorizeMcpAcquisitionPlan(req: Request, res: Response): Promise<void> {
  // Method is assigned by auth middleware, never supplied by headers/body.
  if (!(req as any).user?.isAdmin || !['jwt', 'session'].includes((req as any).authMethod)) {
    res.status(403).json({ success: false, message: 'Dashboard administrator authentication is required' }); return;
  }
  const owner = ownerOf(req);
  if (!owner) { res.status(401).json({ success: false, message: 'Authenticated owner is required' }); return; }
  const { digest, idempotencyKey } = req.body ?? {};
  if (typeof digest !== 'string' || typeof idempotencyKey !== 'string') {
    res.status(400).json({ success: false, message: 'Exact plan digest and idempotency key are required' }); return;
  }
  try {
    const operation = await new AcquisitionPlanRepository(getAppDataSource())
      .authorize(owner, req.params.id as string, digest, idempotencyKey);
    if (!operation) { res.status(409).json({ success: false, message: 'Plan changed, expired or conflicts with an existing request' }); return; }
    res.json({ success: true, data: operation });
  } catch (error) {
    if (error instanceof AcquisitionInputError) {
      res.status(400).json({ success: false, message: error.message }); return;
    }
    res.status(503).json({ success: false, message: 'Acquisition authorization is unavailable' });
  }
}

async function operationRequest(req: Request, res: Response, cancel: boolean): Promise<void> {
  const owner = ownerOf(req);
  if (!owner) { res.status(401).json({ success: false, message: 'Authenticated owner is required' }); return; }
  try {
    const repository = new AcquisitionOperationRepository(getAppDataSource());
    const result = cancel ? await repository.cancel(owner, req.params.id as string)
      : await repository.get(owner, req.params.id as string);
    if (!result) { res.status(404).json({ success: false, message: 'Operation is unavailable' }); return; }
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof AcquisitionInputError) {
      res.status(400).json({ success: false, message: error.message }); return;
    }
    res.status(503).json({ success: false, message: 'Acquisition operation storage is unavailable' });
  }
}
export const getMcpAcquisitionOperation = (req: Request, res: Response) => operationRequest(req, res, false);
export const cancelMcpAcquisitionOperation = (req: Request, res: Response) => operationRequest(req, res, true);

export async function executeMcpAcquisitionOperation(req: Request, res: Response): Promise<void> {
  if (!(req as any).user?.isAdmin || !['jwt', 'session'].includes((req as any).authMethod)) {
    res.status(403).json({ success: false, message: 'Dashboard administrator authentication is required' }); return;
  }
  const owner = ownerOf(req);
  if (!owner) { res.status(401).json({ success: false, message: 'Authenticated owner is required' }); return; }
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'credentials')) {
    res.status(400).json({ success: false, message: 'Only reviewed credentials may be supplied' }); return;
  }
  try {
    const credentials = Object.prototype.hasOwnProperty.call(body, 'credentials') ? body.credentials : {};
    const result = await enqueueAcquisitionExecution(owner, req.params.id as string, credentials);
    if (!result.accepted) { res.status(409).json({ success: false, message: 'Operation is unavailable, expired or already started' }); return; }
    res.status(202).json({ success: true, data: { operationId: req.params.id, status: 'accepted' } });
  } catch (error) {
    if (error instanceof AcquisitionInputError) { res.status(400).json({ success: false, message: error.message }); return; }
    if (error instanceof AcquisitionExecutionUnavailable) { res.status(503).json({ success: false, message: error.message }); return; }
    res.status(503).json({ success: false, message: 'Unable to start acquisition execution' });
  } finally { req.body = {}; }
}
