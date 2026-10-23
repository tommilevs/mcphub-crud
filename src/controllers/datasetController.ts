import {loadDatasetCalls} from '../services/datasetSource.js';
import type { Request,Response } from 'express';
import { requireAdmin } from '../utils/requireAdmin.js';
import { getAppDataSource } from '../db/connection.js';
import { buildDataset } from '../services/datasetBuilder.js';
import {applyDatasetRegistry,recordDatasetExport,datasetOwnerScope,DatasetSplitConflict} from '../services/datasetRegistry.js';
import {buildTrajectoryDataset} from '../services/datasetTrajectory.js';
import {buildDpoDataset,DpoSelectionTooLarge} from '../services/datasetDpo.js';
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
  if(format==='tool-preference-dpo'&&process.env.MCPHUB_DPO_ENABLED!=='true'){res.status(404).json({success:false,message:'DPO is disabled'});return;}
  if(typeof username!=='string'||!username||!Array.isArray(resultIds)||resultIds.length<1||resultIds.length>100||
    resultIds.some((id:unknown)=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))||
    (keyId!==null&&(typeof keyId!=='string'||!keyId||keyId.length>255))||typeof allowSelfReported!=='boolean'||
    typeof seed!=='string'||!seed||seed.length>128||!['tool-selection-sft','recorded-tool-trajectory','tool-preference-dpo'].includes(format)||(download&&!['train','validation','test'].includes(split))){
    res.status(400).json({success:false,message:'Invalid dataset selection (1–100 result IDs, one owner/key scope, supported format/split required)'});return;
  }
  try{
    const ids=[...new Set(resultIds)];
    const generate=async(db:{query(sql:string,parameters?:any[]):Promise<any[]>})=>{
    const calls=await loadDatasetCalls(db,ids,username,keyId,format==='recorded-tool-trajectory');
    const options={username,keyId,allowSelfReported,seed};
    const dataset=format==='tool-preference-dpo'?await buildDpoDataset(db,calls,options):
      (format==='recorded-tool-trajectory'?buildTrajectoryDataset:buildDataset)(calls,options);
    const missing=ids.length-calls.length;
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
    res.setHeader('Content-Disposition',`attachment; filename="mcphub-${format==='recorded-tool-trajectory'?'trajectory':format==='tool-preference-dpo'?'dpo':'sft'}-${split}.jsonl"`);
    res.setHeader('X-Dataset-Manifest-Digest',exported.dataset.manifest.contentSha256);
    res.setHeader('X-Dataset-Export-Id',exported.record.id);
    res.setHeader('X-Dataset-File-Digest',exported.record.fileSha256);
    res.send(exported.body);
  }catch(error){
    if(error instanceof DatasetSplitConflict){res.status(409).json({success:false,message:error.message});return;}
    if(error instanceof DpoSelectionTooLarge){res.status(413).json({success:false,message:error.message});return;}
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
