import type { Request,Response } from 'express';
import { requireAdmin } from '../utils/requireAdmin.js';
import { getAppDataSource } from '../db/connection.js';
import { buildDataset, type DatasetCall } from '../services/datasetBuilder.js';
import {applyDatasetRegistry,recordDatasetExport,datasetOwnerScope,DatasetSplitConflict} from '../services/datasetRegistry.js';
import {buildTrajectoryDataset} from '../services/datasetTrajectory.js';
class DatasetExportTooLarge extends Error{}

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
    typeof seed!=='string'||!seed||seed.length>128||!['tool-selection-sft','recorded-tool-trajectory'].includes(format)||(download&&!['train','validation','test'].includes(split))){
    res.status(400).json({success:false,message:'Invalid dataset selection (1–100 result IDs, one owner/key scope, supported format/split required)'});return;
  }
  try{
    const ids=[...new Set(resultIds)];
    const generate=async(db:{query(sql:string,parameters?:any[]):Promise<any[]>})=>{
    const rows=await db.query(`SELECT result.result_id,result.username,result.key_id,result.attribution,result.timestamp,result.status,
      CASE WHEN $4::boolean THEN (SELECT count(*) FROM tool_results member WHERE member.username=result.username AND member.key_id IS NOT DISTINCT FROM result.key_id
        AND member.attribution->>'taskId'=result.attribution->>'taskId' AND member.attribution->>'traceId'=result.attribution->>'traceId'
        AND member.attribution->>'branchId'=result.attribution->>'branchId' AND member.attribution->>'modelSegmentId'=result.attribution->>'modelSegmentId') ELSE NULL END AS retained_segment_calls,
      result.payload_available,result.raw_sha256,result.objective,result.arguments,
      task.outcome,task.training_consent,task.revision AS task_revision,
      review.quality,review.privacy,review.raw_sha256 AS review_digest,review.revision AS review_revision,
      context.tool_catalogue,context.privacy_approved,context.revision AS context_revision
      FROM tool_results result
      LEFT JOIN LATERAL(SELECT * FROM attribution_task_reviews WHERE task_id::text=result.attribution->>'taskId' ORDER BY revision DESC LIMIT 1) task ON TRUE
      LEFT JOIN LATERAL(SELECT * FROM tool_result_reviews WHERE result_id=result.result_id ORDER BY revision DESC LIMIT 1) review ON TRUE
      LEFT JOIN LATERAL(SELECT * FROM tool_result_training_contexts WHERE result_id=result.result_id ORDER BY revision DESC LIMIT 1) context ON TRUE
      WHERE result.result_id=ANY($1::uuid[]) AND result.username=$2 AND result.key_id IS NOT DISTINCT FROM $3`,[ids,username,keyId,format==='recorded-tool-trajectory']);
    const calls:DatasetCall[]=rows.map((row:any)=>({resultId:row.result_id,username:row.username,keyId:row.key_id,
      taskId:row.attribution?.taskId??null,traceId:row.attribution?.traceId??null,branchId:row.attribution?.branchId??null,callId:row.attribution?.callId??null,
      segmentId:row.attribution?.modelSegmentId??null,modelId:row.attribution?.identity?.modelId??null,
      source:row.attribution?.identity?.source??'unknown',verified:row.attribution?.identity?.verified===true,
      causal:row.attribution?.provenance?.causalCorrelationVerified===true,conflict:Boolean(row.attribution?.conflictReason),
      payloadAvailable:row.payload_available===true,rawSha256:row.raw_sha256,objective:row.objective,
      toolName:row.attribution?.invokedToolName??null,arguments:row.arguments,tools:row.tool_catalogue??[],
      consent:row.training_consent===true,outcome:row.outcome??'unknown',quality:row.quality??'unknown',
      privacy:row.privacy==='approved',contextPrivacy:row.privacy_approved===true,reviewDigest:row.review_digest,
      reviewRevision:row.review_revision??0,contextRevision:row.context_revision??0,taskRevision:row.task_revision??0,
      timestamp:row.timestamp?new Date(row.timestamp).toISOString():undefined,status:row.status,retainedSegmentCalls:Number(row.retained_segment_calls)}));
    const dataset=(format==='recorded-tool-trajectory'?buildTrajectoryDataset:buildDataset)(calls,{username,keyId,allowSelfReported,seed});
    const missing=ids.length-rows.length;
    if(missing)dataset.manifest.excluded.unavailable_or_out_of_scope=missing;
    dataset.manifest.selected=ids.length;
    await applyDatasetRegistry(db,dataset,username,keyId);
    return dataset;
    };
    if(!download){
      const dataset=await generate(getAppDataSource());
      res.setHeader('Cache-Control','no-store');res.json({success:true,data:dataset.manifest});return;
    }
    const exported=await getAppDataSource().transaction(async manager=>{
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[datasetOwnerScope(username,keyId)]);
    const dataset=await generate(manager);
    const content=dataset.examples.filter(row=>row.metadata.split===split).map(row=>JSON.stringify(row)).join('\n');
    const body=content?`${content}\n`:'';
    if(Buffer.byteLength(body,'utf8')>10*1024*1024)throw new DatasetExportTooLarge();
    const record=await recordDatasetExport(manager,dataset,{username,keyId,split,ids,content:body});
    return {body,dataset,record};
    });
    res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Disposition',`attachment; filename="mcphub-${format==='recorded-tool-trajectory'?'trajectory':'sft'}-${split}.jsonl"`);
    res.setHeader('X-Dataset-Manifest-Digest',exported.dataset.manifest.contentSha256);
    res.setHeader('X-Dataset-Export-Id',exported.record.id);
    res.setHeader('X-Dataset-File-Digest',exported.record.fileSha256);
    res.send(exported.body);
  }catch(error){
    if(error instanceof DatasetSplitConflict){res.status(409).json({success:false,message:error.message});return;}
    if(error instanceof DatasetExportTooLarge){res.status(413).json({success:false,message:'Export exceeds 10 MiB; reduce selection'});return;}
    res.status(503).json({success:false,message:'Dataset Builder is unavailable'});
  }
}
export const previewDataset=(req:Request,res:Response)=>datasetRequest(req,res,false);
export const exportDataset=(req:Request,res:Response)=>datasetRequest(req,res,true);

export async function listDatasetExports(req:Request,res:Response):Promise<void>{
  if(!await requireAdmin(req,res))return;
  if(process.env.MCPHUB_DATASET_BUILDER_ENABLED!=='true'){res.status(404).json({success:false,message:'Dataset Builder is disabled'});return;}
  const username=(req as any).user?.username,keyId=req.query.keyId??null;
  if(typeof username!=='string'||!username||(keyId!==null&&(typeof keyId!=='string'||!keyId||keyId.length>255))){
    res.status(400).json({success:false,message:'Invalid dataset scope'});return;
  }
  try{
    const rows=await getAppDataSource().query(`SELECT export_id,split,selected_ids,exported_ids,manifest,file_sha256,byte_length,created_at
      FROM dataset_exports WHERE username=$1 AND key_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC,export_id LIMIT 50`,[username,keyId]);
    res.setHeader('Cache-Control','no-store');res.json({success:true,data:rows});
  }catch{res.status(503).json({success:false,message:'Dataset export history is unavailable'});}
}
