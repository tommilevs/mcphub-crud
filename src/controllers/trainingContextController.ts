import type { Request, Response } from 'express';
import { requireAdmin } from '../utils/requireAdmin.js';
import { getAppDataSource } from '../db/connection.js';
import { prepareTrainingCatalogue } from '../services/trainingContext.js';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function getTrainingContext(req: Request,res: Response): Promise<void> {
  if (!await requireAdmin(req,res)) return;
  const id=req.params.id;
  if(!uuid(id)){res.status(400).json({success:false,message:'Invalid result ID'});return;}
  try {
    const rows=await getAppDataSource().query(`SELECT json_build_object(
      'objective',result.objective,
      'invokedToolName',result.attribution->>'invokedToolName',
      'current',(SELECT json_build_object('revision',revision,'discoveryCallId',discovery_call_id,
        'tools',tool_catalogue,'privacyApproved',privacy_approved,'reviewedBy',reviewed_by,'reviewedAt',reviewed_at)
        FROM tool_result_training_contexts WHERE result_id=result.result_id ORDER BY revision DESC LIMIT 1),
      'sources',COALESCE((SELECT json_agg(source) FROM (
        SELECT discovery.call_id AS "callId",discovery.occurred_at AS "occurredAt",discovery.evidence
        FROM attribution_discovery_events discovery
        WHERE discovery.trace_id::text=result.attribution->>'traceId' AND discovery.branch_id::text=result.attribution->>'branchId'
          AND discovery.occurred_at<=result.timestamp AND discovery.evidence->>'operation'='search_tools'
          AND discovery.evidence->>'truncated'='false'
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(discovery.evidence->'candidates') candidate
            WHERE candidate->>'name'=result.attribution->>'invokedToolName')
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(discovery.evidence->'candidates') candidate
            WHERE candidate->>'schemaSha256' IS NULL)
        ORDER BY discovery.occurred_at DESC,discovery.call_id DESC LIMIT 50
      ) source),'[]'::json)) AS data FROM tool_results result WHERE result.result_id=$1`,[id]);
    if(!rows.length){res.status(404).json({success:false,message:'Result not found'});return;}
    res.json({success:true,data:rows[0].data});
  }catch{res.status(503).json({success:false,message:'Training context is unavailable'});}
}

export async function saveTrainingContext(req: Request,res: Response): Promise<void> {
  if (!await requireAdmin(req,res)) return;
  const id=req.params.id, {revision,discoveryCallId,tools,privacyApproved}=req.body??{};
  const reviewer=(req as any).user?.username;
  const catalogue=prepareTrainingCatalogue(tools);
  const revoke=privacyApproved===false && Number.isSafeInteger(revision) && revision>0;
  if (!uuid(id) || !Number.isSafeInteger(revision) || revision<0 || revision>=2147483647 ||
    typeof privacyApproved!=='boolean' || typeof reviewer!=='string' || !reviewer || (!revoke && (!uuid(discoveryCallId)||!catalogue))) {
    res.status(400).json({success:false,message:'Invalid training context'});return;
  }
  try {
    if(revoke){
      const rows=await getAppDataSource().query(`INSERT INTO tool_result_training_contexts
        (result_id,revision,discovery_call_id,objective,tool_catalogue,privacy_approved,reviewed_by)
        SELECT result_id,$2,discovery_call_id,objective,tool_catalogue,false,$3 FROM tool_result_training_contexts
        WHERE result_id=$1 AND revision=$4 AND revision=(SELECT MAX(revision) FROM tool_result_training_contexts WHERE result_id=$1)
        ON CONFLICT(result_id,revision) DO NOTHING RETURNING revision,privacy_approved`,[id,revision+1,reviewer,revision]);
      if(!rows.length){res.status(409).json({success:false,message:'Training context changed; reload'});return;}
      res.json({success:true,data:rows[0]});return;
    }
    const rows=await getAppDataSource().query(`INSERT INTO tool_result_training_contexts
      (result_id,revision,discovery_call_id,objective,tool_catalogue,privacy_approved,reviewed_by)
      SELECT result.result_id,$2,discovery.call_id,result.objective,$4::jsonb,$5,$6
      FROM tool_results result JOIN attribution_discovery_events discovery
        ON discovery.trace_id::text=result.attribution->>'traceId' AND discovery.branch_id::text=result.attribution->>'branchId'
      WHERE result.result_id=$1 AND discovery.call_id=$3 AND discovery.occurred_at<=result.timestamp
        AND discovery.evidence->>'operation'='search_tools' AND discovery.evidence->>'truncated'='false'
        AND discovery.evidence->'candidates'=$7::jsonb AND NULLIF(result.objective,'') IS NOT NULL
        AND result.attribution->>'invokedToolName' IN (SELECT item->>'name' FROM jsonb_array_elements($4::jsonb) item)
        AND COALESCE((SELECT MAX(revision) FROM tool_result_training_contexts WHERE result_id=$1),0)=$8
      ON CONFLICT(result_id,revision) DO NOTHING RETURNING revision,privacy_approved`,
    [id,revision+1,discoveryCallId,JSON.stringify(catalogue!.tools),privacyApproved,reviewer,JSON.stringify(catalogue!.fingerprints),revision]);
    if(!rows.length){res.status(409).json({success:false,message:'Context must match complete prior discovery in this call branch and current revision; reload'});return;}
    res.json({success:true,data:rows[0]});
  }catch{res.status(503).json({success:false,message:'Training context is unavailable'});}
}
