import type { Request,Response } from 'express';
import { requireAdmin } from '../utils/requireAdmin.js';
import { getAppDataSource } from '../db/connection.js';
import { buildDataset, type DatasetCall } from '../services/datasetBuilder.js';

export async function getDatasetAvailability(req:Request,res:Response):Promise<void>{
  if(!await requireAdmin(req,res))return;
  res.json({success:true,data:{enabled:process.env.MCPHUB_DATASET_BUILDER_ENABLED==='true'}});
}

async function datasetRequest(req:Request,res:Response,download:boolean):Promise<void>{
  if(!await requireAdmin(req,res))return;
  if(process.env.MCPHUB_DATASET_BUILDER_ENABLED!=='true'){res.status(404).json({success:false,message:'Dataset Builder is disabled'});return;}
  const {resultIds,keyId=null,allowSelfReported=false,seed='mcphub-v1',split,format='tool-selection-sft'}=req.body??{};
  const username=(req as any).user?.username;
  if(typeof username!=='string'||!username||!Array.isArray(resultIds)||resultIds.length<1||resultIds.length>100||
    resultIds.some((id:unknown)=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))||
    (keyId!==null&&(typeof keyId!=='string'||!keyId||keyId.length>255))||typeof allowSelfReported!=='boolean'||
    typeof seed!=='string'||!seed||seed.length>128||format!=='tool-selection-sft'||(download&&!['train','validation','test'].includes(split))){
    res.status(400).json({success:false,message:'Invalid dataset selection (1–100 result IDs, one owner/key scope, supported format/split required)'});return;
  }
  try{
    const ids=[...new Set(resultIds)];
    const rows=await getAppDataSource().query(`SELECT result.result_id,result.username,result.key_id,result.attribution,
      result.payload_available,result.raw_sha256,result.objective,result.arguments,
      task.outcome,task.training_consent,task.revision AS task_revision,
      review.quality,review.privacy,review.raw_sha256 AS review_digest,review.revision AS review_revision,
      context.tool_catalogue,context.privacy_approved,context.revision AS context_revision
      FROM tool_results result
      LEFT JOIN LATERAL(SELECT * FROM attribution_task_reviews WHERE task_id::text=result.attribution->>'taskId' ORDER BY revision DESC LIMIT 1) task ON TRUE
      LEFT JOIN LATERAL(SELECT * FROM tool_result_reviews WHERE result_id=result.result_id ORDER BY revision DESC LIMIT 1) review ON TRUE
      LEFT JOIN LATERAL(SELECT * FROM tool_result_training_contexts WHERE result_id=result.result_id ORDER BY revision DESC LIMIT 1) context ON TRUE
      WHERE result.result_id=ANY($1::uuid[]) AND result.username=$2 AND result.key_id IS NOT DISTINCT FROM $3`,[ids,username,keyId]);
    const calls:DatasetCall[]=rows.map((row:any)=>({resultId:row.result_id,username:row.username,keyId:row.key_id,
      taskId:row.attribution?.taskId??null,traceId:row.attribution?.traceId??null,branchId:row.attribution?.branchId??null,
      segmentId:row.attribution?.modelSegmentId??null,modelId:row.attribution?.identity?.modelId??null,
      source:row.attribution?.identity?.source??'unknown',verified:row.attribution?.identity?.verified===true,
      causal:row.attribution?.provenance?.causalCorrelationVerified===true,conflict:Boolean(row.attribution?.conflictReason),
      payloadAvailable:row.payload_available===true,rawSha256:row.raw_sha256,objective:row.objective,
      toolName:row.attribution?.invokedToolName??null,arguments:row.arguments,tools:row.tool_catalogue??[],
      consent:row.training_consent===true,outcome:row.outcome??'unknown',quality:row.quality??'unknown',
      privacy:row.privacy==='approved',contextPrivacy:row.privacy_approved===true,reviewDigest:row.review_digest,
      reviewRevision:row.review_revision??0,contextRevision:row.context_revision??0,taskRevision:row.task_revision??0}));
    const dataset=buildDataset(calls,{username,keyId,allowSelfReported,seed});
    const missing=ids.length-rows.length;
    if(missing)dataset.manifest.excluded.unavailable_or_out_of_scope=missing;
    dataset.manifest.selected=ids.length;
    if(!download){res.setHeader('Cache-Control','no-store');res.json({success:true,data:dataset.manifest});return;}
    const content=dataset.examples.filter(row=>row.metadata.split===split).map(row=>JSON.stringify(row)).join('\n');
    if(Buffer.byteLength(content,'utf8')>10*1024*1024){res.status(413).json({success:false,message:'Export exceeds 10 MiB; reduce selection'});return;}
    res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Disposition',`attachment; filename="mcphub-sft-${split}.jsonl"`);
    res.setHeader('X-Dataset-Manifest-Digest',dataset.manifest.contentSha256);
    res.send(content?`${content}\n`:'');
  }catch{res.status(503).json({success:false,message:'Dataset Builder is unavailable'});}
}
export const previewDataset=(req:Request,res:Response)=>datasetRequest(req,res,false);
export const exportDataset=(req:Request,res:Response)=>datasetRequest(req,res,true);
