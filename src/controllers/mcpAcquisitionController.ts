import type { Request, Response } from 'express';
import { loadSettings } from '../config/configManager.js';
import { getMarketServers } from '../services/marketService.js';
import { AcquisitionInputError, proposeMcpServers } from '../services/mcpAcquisitionService.js';

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
