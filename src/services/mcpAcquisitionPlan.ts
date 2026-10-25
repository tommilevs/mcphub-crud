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
  probe?: { tool: string };
}

export function buildAcquisitionManifest(server: MarketServer, version: string, targetGroup: string, probeTool?: string): AcquisitionManifest {
  if (probeTool !== undefined && (typeof probeTool !== 'string' || !probeTool.trim() || probeTool.length > 255 || /[\u0000-\u001f\u007f]/.test(probeTool))) {
    throw new AcquisitionInputError('Invalid explicitly reviewed probe tool');
  }
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
    ...(probeTool ? { probe: { tool: probeTool } } : {}),
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
    const rows = await this.db.query(`SELECT p.plan_id,p.manifest,p.manifest_digest,p.created_at,p.expires_at,
      o.operation_id,o.state AS operation_state
      FROM mcp_acquisition_plans p LEFT JOIN mcp_acquisition_operations o ON o.plan_id=p.plan_id AND o.owner=p.owner
      WHERE p.plan_id=$1 AND p.owner=$2 AND p.expires_at>NOW()`, [planId, owner]);
    if (!rows.length) return null;
    if (acquisitionManifestDigest(rows[0].manifest) !== rows[0].manifest_digest) {
      throw new Error('Acquisition plan integrity check failed');
    }
    return rows[0];
  }

  async authorize(owner: string, planId: string, digest: string, idempotencyKey: string) {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!uuid.test(planId) || !uuid.test(idempotencyKey) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new AcquisitionInputError('Invalid plan approval');
    }
    const plan = await this.get(owner, planId);
    if (!plan || plan.manifest_digest !== digest) return null;
    // Eligibility is checked again inside INSERT to close the expiry race.
    const rows = await this.db.query(`INSERT INTO mcp_acquisition_operations
      (operation_id,plan_id,owner,manifest_digest,idempotency_key)
      SELECT $1,p.plan_id,p.owner,p.manifest_digest,$5 FROM mcp_acquisition_plans p
      WHERE p.plan_id=$2 AND p.owner=$3 AND p.manifest_digest=$4 AND p.expires_at>NOW()
      ON CONFLICT DO NOTHING RETURNING operation_id,plan_id,manifest_digest,state,authorized_at`,
    [randomUUID(), planId, owner, digest, idempotencyKey]);
    if (rows.length) return rows[0];
    // A new statement sees a concurrently committed winning insert.
    const existing = await this.db.query(`SELECT o.operation_id,o.plan_id,o.manifest_digest,o.state,o.authorized_at
      FROM mcp_acquisition_operations o JOIN mcp_acquisition_plans p ON p.plan_id=o.plan_id
      WHERE o.plan_id=$1 AND o.owner=$2 AND o.manifest_digest=$3 AND p.expires_at>NOW()
      AND NOT EXISTS(SELECT 1 FROM mcp_acquisition_operations other
        WHERE other.owner=$2 AND other.idempotency_key=$4 AND other.plan_id<>$1)`, [planId, owner, digest, idempotencyKey]);
    return existing[0] ?? null;
  }
}
