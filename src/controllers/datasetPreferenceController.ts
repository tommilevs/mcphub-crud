import type {Request,Response} from 'express';
import {requireAdmin} from '../utils/requireAdmin.js';
import {getAppDataSource} from '../db/connection.js';
import {createPreference,listPreferences,reviewPreference} from '../services/datasetPreference.js';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export async function datasetPreferenceAvailability(req:Request,res:Response):Promise<void>{
  if(!await requireAdmin(req,res))return;
  res.json({success:true,data:{enabled:process.env.MCPHUB_DATASET_BUILDER_ENABLED==='true'&&process.env.MCPHUB_DPO_ENABLED==='true'}});
}
export async function manageDatasetPreferences(req:Request,res:Response):Promise<void>{
  if(!await requireAdmin(req,res))return;
  if(process.env.MCPHUB_DATASET_BUILDER_ENABLED!=='true'||process.env.MCPHUB_DPO_ENABLED!=='true'){
    res.status(404).json({success:false,message:'DPO is disabled'});return;
  }
  const username=(req as any).user?.username,keyId=(req.method==='GET'?req.query.keyId:req.body?.keyId)??null;
  if(typeof username!=='string'||!username||(keyId!==null&&(typeof keyId!=='string'||!keyId||keyId.length>255))){
    res.status(400).json({success:false,message:'Invalid preference scope'});return;
  }
  try{
    const options={username,keyId:keyId as string|null};let data;
    if(req.method==='GET')data=await listPreferences(getAppDataSource(),options);
    else if(req.method==='POST'){
      const {chosenId,rejectedId,rationale,comparabilityConfirmed,allowSelfReported=false}=req.body??{};
      if(!uuid(chosenId)||!uuid(rejectedId)||chosenId===rejectedId||comparabilityConfirmed!==true||typeof allowSelfReported!=='boolean'||
        typeof rationale!=='string'||!rationale.trim()||rationale.length>4000){
        res.status(400).json({success:false,message:'Confirm comparable derived context and explain the preference'});return;
      }
      data=await createPreference(getAppDataSource(),{...options,allowSelfReported},{chosenId,rejectedId,rationale:rationale.trim()});
    }else{
      const {revision,status,rationale,comparabilityConfirmed,privacyApproved}=req.body??{};
      if(!uuid(req.params.id)||!Number.isSafeInteger(revision)||revision<1||revision>=2147483647||!['draft','approved','retired'].includes(status)||
        (rationale!==undefined&&(typeof rationale!=='string'||!rationale.trim()||rationale.length>4000))||
        (status==='approved'&&(comparabilityConfirmed!==true||privacyApproved!==true||rationale!==undefined))){
        res.status(400).json({success:false,message:'Approve the exact saved revision with context and privacy review'});return;
      }
      data=await reviewPreference(getAppDataSource(),options,req.params.id,{revision,status,rationale});
    }
    if(!data){res.status(409).json({success:false,message:'Preference exists, changed, or its reviewed source/context is no longer eligible'});return;}
    res.setHeader('Cache-Control','no-store');res.json({success:true,data});
  }catch{res.status(503).json({success:false,message:'Preference review is unavailable'});}
}
