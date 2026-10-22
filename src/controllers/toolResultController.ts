import type { Request, Response } from 'express';
import type { ToolResultFilter, ToolResultRecord } from '../types/toolResult.js';
import {
  getToolResultRepository,
  isToolResultHistoryAvailable,
} from '../services/toolResultHistoryRegistry.js';
import { requireAdmin } from '../utils/requireAdmin.js';
import { logger } from '../utils/logger.js';
import { generateEmbedding } from '../services/vectorSearchService.js';

const publicRecord = (record: ToolResultRecord): Omit<ToolResultRecord, 'raw' | 'rawText'> => {
  const { raw: _raw, rawText: _rawText, ...metadata } = record;
  return metadata;
};

const requireRepository = (res: Response) => {
  const repository = getToolResultRepository();
  if (!repository) {
    res.status(404).json({ success: false, message: 'Tool result history requires database mode' });
  }
  return repository;
};

const parseFilter = (req: Request): ToolResultFilter => {
  const filter: ToolResultFilter = {};
  if (typeof req.query.server === 'string' && req.query.server) filter.server = req.query.server;
  if (typeof req.query.tool === 'string' && req.query.tool) filter.tool = req.query.tool;
  if (req.query.status === 'success' || req.query.status === 'error') filter.status = req.query.status;
  if (typeof req.query.username === 'string' && req.query.username) filter.username = req.query.username;
  if (typeof req.query.sessionId === 'string' && req.query.sessionId) filter.sessionId = req.query.sessionId;
  if (typeof req.query.conversationId === 'string' && req.query.conversationId) filter.conversationId = req.query.conversationId;
  if (req.query.pinned === 'true') filter.pinned = true;
  if (req.query.pinned === 'false') filter.pinned = false;
  if (typeof req.query.startDate === 'string') filter.startDate = new Date(req.query.startDate);
  if (typeof req.query.endDate === 'string') filter.endDate = new Date(req.query.endDate);
  return filter;
};

export const checkToolResultHistoryAvailable = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  res.json({ success: true, data: { available: isToolResultHistoryAvailable() } });
};

export const getToolResults = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const repository = requireRepository(res);
  if (!repository) return;
  const page = Number.parseInt(String(req.query.page ?? '1'), 10);
  const limit = Number.parseInt(String(req.query.limit ?? '20'), 10);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    res.status(400).json({ success: false, message: 'Invalid pagination' });
    return;
  }
  try {
    const result = await repository.findPaginated(page, limit, parseFilter(req));
    res.json({
      success: true,
      data: result.data.map(publicRecord),
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
        hasNextPage: result.page < result.totalPages,
        hasPrevPage: result.page > 1,
      },
    });
  } catch (error) {
    logger.error('Failed to list tool results:', error);
    res.status(500).json({ success: false, message: 'Failed to list tool results' });
  }
};

export const getToolResultById = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const repository = requireRepository(res);
  if (!repository) return;
  const record = await repository.findById(req.params.id);
  if (!record) {
    res.status(404).json({ success: false, message: 'Tool result not found' });
    return;
  }
  await repository.incrementUseCount(record.resultId);
  res.json({ success: true, data: publicRecord(record) });
};

export const getToolResultRaw = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const repository = requireRepository(res);
  if (!repository) return;
  const record = await repository.findById(req.params.id);
  if (!record) {
    res.status(404).json({ success: false, message: 'Tool result not found' });
    return;
  }
  if (!record.payloadAvailable || record.raw === null) {
    res.status(409).json({
      success: false,
      message: record.payloadOmissionReason ?? 'RAW payload is unavailable',
    });
    return;
  }
  await repository.incrementUseCount(record.resultId);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(record.raw);
};

export const getToolResultRange = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const repository = requireRepository(res);
  if (!repository) return;
  const record = await repository.findById(req.params.id);
  if (!record) {
    res.status(404).json({ success: false, message: 'Tool result not found' });
    return;
  }
  if (!record.payloadAvailable || record.raw === null) {
    res.status(409).json({ success: false, message: 'RAW payload is unavailable' });
    return;
  }
  const start = Number(req.query.start);
  const end = Number(req.query.end);
  const bytes = Buffer.from(record.raw, 'utf8');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bytes.length) {
    res.status(400).json({ success: false, message: 'Invalid byte range' });
    return;
  }
  await repository.incrementUseCount(record.resultId);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Range', `bytes ${start}-${end - 1}/${bytes.length}`);
  res.send(bytes.subarray(start, end));
};

export const searchToolResults = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const repository = requireRepository(res);
  if (!repository) return;
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limit = Number.parseInt(String(req.query.limit ?? '20'), 10);
  if (!query || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    res.status(400).json({ success: false, message: 'Invalid search query' });
    return;
  }
  let mode: 'hybrid' | 'lexical' = 'lexical';
  let data: ToolResultRecord[] = [];
  if (repository.hybridSearch) {
    try {
      const embedding = await generateEmbedding(query, 'query');
      data = await repository.hybridSearch(query, embedding, limit, parseFilter(req));
      mode = 'hybrid';
    } catch (error) {
      logger.warn('Hybrid result search fell back to lexical search:', error);
      data = await repository.search(query, limit, parseFilter(req));
    }
  } else {
    data = await repository.search(query, limit, parseFilter(req));
  }
  res.json({ success: true, data: data.map(publicRecord), meta: { mode } });
};

export const pinToolResult = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const repository = requireRepository(res);
  if (!repository) return;
  if (typeof req.body?.pinned !== 'boolean') {
    res.status(400).json({ success: false, message: 'pinned must be a boolean' });
    return;
  }
  const record = await repository.setPinned(req.params.id, req.body.pinned);
  if (!record) {
    res.status(404).json({ success: false, message: 'Tool result not found' });
    return;
  }
  res.json({ success: true, data: publicRecord(record) });
};

export const getToolResultStats = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const repository = requireRepository(res);
  if (!repository) return;
  res.json({ success: true, data: await repository.getStats(parseFilter(req)) });
};
