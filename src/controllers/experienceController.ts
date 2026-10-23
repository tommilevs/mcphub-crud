import type {Request,Response} from 'express';
import {requireAdmin} from '../utils/requireAdmin.js';
import {getAppDataSource} from '../db/connection.js';
import {createExperience,searchExperiences,loadExperienceEvidence} from '../services/experienceMemory.js';
import {assessExperienceEvidence} from '../services/experienceEvidence.js';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&Boolean(value.trim())&&value.length<=max;
const key=(value:unknown)=>value===null||text(value,255);
const map=(value:unknown)=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value as object).length<=100&&
  Object.entries(value as object).every(([name,item])=>text(name,255)&&text(item,255));
async function enabled(req:Request,res:Response){
  if(!await requireAdmin(req,res))return false;
  if(process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED!=='true'){res.status(404).json({success:false,message:'Experience Memory is disabled'});return false;}
  if(!text((req as any).user?.username,255)){res.status(400).json({success:false,message:'Authenticated owner is required'});return false;}
  return true;
}
export async function saveExperience(req:Request,res:Response):Promise<void>{
  if(!await enabled(req,res))return;
  const {title,summary,taskType='general',keyId=null,evidenceIds,approved=false,scope={},toolVersions={}}=req.body??{};
  const validScope=scope&&typeof scope==='object'&&!Array.isArray(scope)&&Object.entries(scope).every(([name,items])=>
    ['servers','tools'].includes(name)&&Array.isArray(items)&&items.length<=100&&items.every(item=>text(item,255)));
  if(!text(title,160)||!text(summary,4000)||!text(taskType,255)||!key(keyId)||typeof approved!=='boolean'||!validScope||!map(toolVersions)||
    !Array.isArray(evidenceIds)||!evidenceIds.length||evidenceIds.length>20||!evidenceIds.every(uuid)){
    res.status(400).json({success:false,message:'Invalid experience proposal'});return;
  }
  try{
    const result=await createExperience({username:(req as any).user.username,keyId,title,summary,taskType,scope,toolVersions,
      evidenceIds:[...new Set<string>(evidenceIds)],approved});
    if(!result){res.status(409).json({success:false,message:'Evidence unavailable, out of scope or no longer reviewed as positive'});return;}
    res.json({success:true,data:result});
  }catch{res.status(503).json({success:false,message:'Experience Memory is unavailable'});}
}
export async function findExperiences(req:Request,res:Response):Promise<void>{
  if(!await enabled(req,res))return;
  const q=req.query.q??'',keyId=req.query.keyId??null,taskType=req.query.taskType,limit=Number(req.query.limit??10);
  if(typeof q!=='string'||q.length>1000||!key(keyId)||(taskType!==undefined&&!text(taskType,255))||!Number.isInteger(limit)||limit<1||limit>20){
    res.status(400).json({success:false,message:'Invalid experience search'});return;
  }
  try{res.json({success:true,data:await searchExperiences({username:(req as any).user.username,keyId:keyId as string|null,query:q,
    taskType:taskType as string|undefined,limit})});}catch{res.status(503).json({success:false,message:'Experience Memory is unavailable'});}
}
export async function reviewExperience(req:Request,res:Response):Promise<void>{
  if(!await enabled(req,res))return;
  const {keyId=null,revision,status}=req.body??{},id=req.params.id,username=(req as any).user.username;
  if(!uuid(id)||!key(keyId)||!Number.isSafeInteger(revision)||revision<1||revision>=2147483647||!['draft','approved','retired'].includes(status)){
    res.status(400).json({success:false,message:'Invalid experience review'});return;
  }
  try{
    const db=getAppDataSource();
    const current=await db.query('SELECT evidence_ids FROM experience_entries WHERE experience_id=$1 AND username=$2 AND key_id IS NOT DISTINCT FROM $3 AND revision=$4',[id,username,keyId,revision]);
    if(!current.length){res.status(409).json({success:false,message:'Experience changed or is unavailable'});return;}
    if(status==='approved'&&!assessExperienceEvidence(current[0].evidence_ids,await loadExperienceEvidence(current[0].evidence_ids,username,keyId)).usable){
      res.status(409).json({success:false,message:'Experience evidence is no longer reviewed as positive'});return;
    }
    const rows=await db.query(`WITH updated AS(UPDATE experience_entries SET status=$5,revision=revision+1,reviewed_at=NOW(),reviewed_by=$2
      WHERE experience_id=$1 AND username=$2 AND key_id IS NOT DISTINCT FROM $3 AND revision=$4 RETURNING *)
      INSERT INTO experience_entry_audit(experience_id,revision,snapshot)
      SELECT experience_id,revision,to_jsonb(updated)-'search_vector' FROM updated RETURNING experience_id,revision`,[id,username,keyId,revision,status]);
    if(!rows.length){res.status(409).json({success:false,message:'Experience changed; reload'});return;}
    res.json({success:true,data:rows[0]});
  }catch{res.status(503).json({success:false,message:'Experience Memory is unavailable'});}
}
