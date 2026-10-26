import {randomUUID} from 'node:crypto';
import {acquisitionSecretId} from './mcpAcquisitionSecretIdentity.js';
import type {AcquisitionPlanDb} from './mcpAcquisitionPlan.js';
import {acquisitionRowsDatabase} from './mcpAcquisitionDb.js';
import {AcquisitionInputError} from './mcpAcquisitionService.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type ReviewCode='cleanup_outcome_unknown'|'references_adopted'|'ownership_unconfirmed';

/** Internal receipts, not permission to delete. The coordinator must also prove
 * native terminal ownership and absence of settings/runtime/index references. */
export class AcquisitionCleanupJournal {
  private readonly db:AcquisitionPlanDb;
  constructor(db:AcquisitionPlanDb){this.db=acquisitionRowsDatabase(db);}
  private validate(owner:string,id:string,token?:string){
    if(!owner.trim()||owner.length>255||!uuid.test(id)||(token!==undefined&&!uuid.test(token)))
      throw new AcquisitionInputError('Invalid cleanup identity');
  }
  async get(owner:string,id:string){
    this.validate(owner,id);
    const rows=await this.db.query(`SELECT operation_id,status,files_removed_at,secrets_removed_at,review_code,created_at,updated_at
      FROM mcp_acquisition_cleanup WHERE operation_id=$1 AND owner=$2`,[id,owner]);
    return rows[0]??null;
  }
  async claim(owner:string,id:string){
    this.validate(owner,id);
    const token=randomUUID();
    const rows=await this.db.query(`WITH eligible AS (
      SELECT o.operation_id,o.owner,o.manifest_digest,p.manifest FROM mcp_acquisition_operations o
      JOIN mcp_acquisition_plans p ON p.plan_id=o.plan_id AND p.owner=o.owner AND p.manifest_digest=o.manifest_digest
      WHERE o.operation_id=$1 AND o.owner=$2 AND o.state IN ('cancelled','failed','rolled_back')
      AND NOT o.requires_reconciliation AND (o.publication IS NULL OR o.rollback_digest IS NOT NULL)
      AND (o.activation_claim_id IS NULL OR o.rollback_digest IS NOT NULL)
      FOR UPDATE OF o
    ), claimed AS (
      INSERT INTO mcp_acquisition_cleanup(operation_id,owner,manifest_digest,cleanup_claim_id)
      SELECT operation_id,owner,manifest_digest,$3 FROM eligible
      ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id,cleanup_claim_id,manifest_digest
    ) SELECT c.*,e.manifest FROM claimed c JOIN eligible e USING(operation_id)`,[id,owner,token]);
    return rows[0]??null;
  }
  /** Called only after native deletion confirms this exact deterministic identity. */
  async recordSecret(owner:string,id:string,token:string,inputName:string){
    this.validate(owner,id,token);
    if(typeof inputName!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(inputName)||
      ['__proto__','constructor','prototype'].includes(inputName))
      throw new AcquisitionInputError('Invalid cleanup credential identity');
    const secretId=acquisitionSecretId(owner,id,inputName);
    const rows=await this.db.query(`UPDATE mcp_acquisition_cleanup AS c
      SET secret_receipts=jsonb_set(c.secret_receipts,ARRAY[$4]::text[],
        COALESCE(c.secret_receipts->$4,jsonb_build_object('secret_id',$5::text,'removed_at',NOW()))),updated_at=NOW()
      WHERE c.operation_id=$1 AND c.owner=$2 AND c.cleanup_claim_id=$3 AND c.status='running'
      AND c.files_removed_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM mcp_acquisition_plans p WHERE p.owner=c.owner AND p.manifest_digest=c.manifest_digest
        AND p.manifest->'requiredInputs' ? $4)
      RETURNING c.operation_id`,[id,owner,token,inputName,secretId]);
    return rows.length>0;
  }
  async recordStep(owner:string,id:string,token:string,step:'files'|'secrets'){
    this.validate(owner,id,token);
    if(!['files','secrets'].includes(step))throw new AcquisitionInputError('Invalid cleanup step');
    // Column names are selected from the fixed enum, never supplied by a caller.
    const column=step==='files'?'files_removed_at':'secrets_removed_at';
    const rows=await this.db.query(`UPDATE mcp_acquisition_cleanup AS c SET ${column}=COALESCE(${column},NOW()),
      status=CASE WHEN $4='secrets' AND files_removed_at IS NOT NULL THEN 'complete' ELSE status END,updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND cleanup_claim_id=$3 AND status='running'
      AND ($4='files' OR (files_removed_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM mcp_acquisition_plans p WHERE p.owner=c.owner AND p.manifest_digest=c.manifest_digest
        AND jsonb_array_length(p.manifest->'requiredInputs')=(SELECT COUNT(*) FROM jsonb_object_keys(c.secret_receipts))
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.manifest->'requiredInputs') AS input(name)
          WHERE NOT (c.secret_receipts ? input.name))))) RETURNING operation_id`,[id,owner,token,step]);
    return rows.length>0;
  }
  async requireReview(owner:string,id:string,token:string,code:ReviewCode){
    this.validate(owner,id,token);
    if(!['cleanup_outcome_unknown','references_adopted','ownership_unconfirmed'].includes(code))
      throw new AcquisitionInputError('Invalid cleanup review code');
    const rows=await this.db.query(`UPDATE mcp_acquisition_cleanup SET status='review_required',review_code=$4,updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND cleanup_claim_id=$3 AND status='running' RETURNING operation_id`,[id,owner,token,code]);
    return rows.length>0;
  }
}
