import { createHash, randomUUID } from 'node:crypto';
import type { MarketServer } from '../types/index.js';
import { AcquisitionInputError } from './mcpAcquisitionService.js';

export interface AcquisitionManifest {
  schemaVersion: 1;
  serverName: string;
  targetGroup: string;
  transport: 'stdio';
  package: { ecosystem: 'npm'; name: string; version: string };
  source: { type: 'local_catalog'; repository: string | null };
  requiredInputs: string[];
}

export function buildAcquisitionManifest(server: MarketServer, version: string, targetGroup: string): AcquisitionManifest {
  // Stable releases only for the first adapter: never resolve a mutable tag at execution time.
  if (typeof version !== 'string' || version.trim() !== version ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.length > 64 ||
      typeof targetGroup !== 'string' || !targetGroup.trim() || targetGroup.length > 255) {
    throw new AcquisitionInputError('An exact release version and target group are required');
  }
  const installation = server.installations?.npm;
  const args = installation?.args;
  const packageSpec = Array.isArray(args) && args.length === 2 && args[0] === '-y' ? args[1] : null;
  const match = typeof packageSpec === 'string' ?
    /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[a-zA-Z0-9.+_-]+)?$/.exec(packageSpec) : null;
  if (installation?.command !== 'npx' || installation.type !== 'npm' || !match || packageSpec?.trim() !== packageSpec) {
    throw new AcquisitionInputError('This catalog installer is not supported by the pinned npm adapter');
  }
  return {
    schemaVersion: 1, serverName: server.name, targetGroup, transport: 'stdio',
    package: { ecosystem: 'npm', name: match[1], version },
    source: { type: 'local_catalog', repository: server.repository?.url ?? null },
    requiredInputs: Object.entries(server.arguments ?? {}).filter(([, input]) => input.required)
      .map(([name]) => name).sort(),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function acquisitionManifestDigest(manifest: AcquisitionManifest): string {
  return createHash('sha256').update(canonical(manifest)).digest('hex');
}

export interface AcquisitionPlanDb { query(sql: string, parameters?: any[]): Promise<any[]> }

/** Persistence only. Creating or reading a plan never authorizes or executes it. */
export class AcquisitionPlanRepository {
  constructor(private readonly db: AcquisitionPlanDb) {}

  async create(owner: string, manifest: AcquisitionManifest, ttlSeconds = 1800) {
    if (!owner.trim() || owner.length > 255 || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) {
      throw new AcquisitionInputError('Invalid plan owner or expiry');
    }
    const planId = randomUUID();
    const digest = acquisitionManifestDigest(manifest);
    const rows = await this.db.query(`INSERT INTO mcp_acquisition_plans
      (plan_id,owner,manifest,manifest_digest,expires_at)
      VALUES($1,$2,$3::jsonb,$4,NOW()+$5*INTERVAL '1 second')
      RETURNING plan_id,manifest,manifest_digest,created_at,expires_at`,
    [planId, owner, JSON.stringify(manifest), digest, ttlSeconds]);
    return rows[0];
  }

  async get(owner: string, planId: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(planId)) {
      throw new AcquisitionInputError('Invalid plan identifier');
    }
    const rows = await this.db.query(`SELECT plan_id,manifest,manifest_digest,created_at,expires_at
      FROM mcp_acquisition_plans WHERE plan_id=$1 AND owner=$2 AND expires_at>NOW()`, [planId, owner]);
    if (!rows.length) return null;
    if (acquisitionManifestDigest(rows[0].manifest) !== rows[0].manifest_digest) {
      throw new Error('Acquisition plan integrity check failed');
    }
    return rows[0];
  }
}
