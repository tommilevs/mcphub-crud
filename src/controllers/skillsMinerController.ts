import type {Request,Response} from 'express';
import {requireAdmin} from '../utils/requireAdmin.js';
import {previewSkillFromExperience} from '../services/skillProposalService.js';
import {createSkillProposal,listSkillProposals,reviseSkillProposal,exportSkillProposal,readSkillVersions} from '../services/storedSkillProposals.js';
export async function previewSkillProposal(req:Request,res:Response):Promise<void>{
  if(!await requireAdmin(req,res))return;
  if(process.env.MCPHUB_SKILLS_MINER_ENABLED!=='true'||process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED!=='true'){
    res.status(404).json({success:false,message:'Skills Miner is disabled'});return;
  }
  const {experienceId,keyId=null}=req.body??{},username=(req as any).user?.username;
  if(typeof experienceId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(experienceId)||
    typeof username!=='string'||!username||(keyId!==null&&(typeof keyId!=='string'||!keyId||keyId.length>255))){
    res.status(400).json({success:false,message:'Invalid skill source'});return;
  }
  try{
    const data=await previewSkillFromExperience(experienceId,username,keyId);
    if(!data){res.status(409).json({success:false,message:'At least two independent, reviewed, matching multi-step workflows are required'});return;}
    res.json({success:true,data});
  }catch{res.status(503).json({success:false,message:'Skills Miner is unavailable'});}
}

export async function manageSkillProposals(req:Request,res:Response):Promise<void>{
  if(!await requireAdmin(req,res))return;
  if(process.env.MCPHUB_SKILLS_MINER_ENABLED!=='true'||process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED!=='true'){
    res.status(404).json({success:false,message:'Skills Miner is disabled'});return;
  }
  const username=(req as any).user?.username;
  const keyId=(req.method==='GET'?req.query.keyId:req.body?.keyId)??null;
  const id=req.params.id;
  const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if(typeof username!=='string'||!username||(keyId!==null&&(typeof keyId!=='string'||!keyId||keyId.length>255))||(id!==undefined&&!uuid(id))){
    res.status(400).json({success:false,message:'Invalid skill request'});return;
  }
  const owner={username,keyId:keyId as string|null};
  try{
    let data;
    if(req.method==='GET')data=await listSkillProposals(owner,id);
    else if(id===undefined){
      if(!uuid(req.body?.experienceId)){res.status(400).json({success:false,message:'Invalid skill source'});return;}
      data=await createSkillProposal(req.body.experienceId,owner);
    }else if(req.method==='PATCH'){
      const {revision,status,markdown}=req.body??{};
      if(!Number.isSafeInteger(revision)||revision<1||!['draft','approved','retired'].includes(status)||
        (markdown!==undefined&&(typeof markdown!=='string'||!markdown.trim()||Buffer.byteLength(markdown)>65536))||
        (markdown!==undefined&&status==='approved')){
        res.status(400).json({success:false,message:'Edit a draft before separately approving its revision'});return;
      }
      data=await reviseSkillProposal(id,owner,{revision,status,markdown});
    }else{
      data=await exportSkillProposal(id,owner);
      if(data){
        res.setHeader('Content-Type','text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition','attachment; filename="SKILL.md"');
        res.setHeader('Cache-Control','no-store');res.send(data.markdown);return;
      }
    }
    if(!data){res.status(409).json({success:false,message:'Skill revision or reviewed source is no longer current'});return;}
    res.json({success:true,data});
  }catch{res.status(503).json({success:false,message:'Skills Miner is unavailable'});}
}
export async function getSkillVersions(req:Request,res:Response):Promise<void>{
  if(!await requireAdmin(req,res))return;
  if(process.env.MCPHUB_SKILLS_MINER_ENABLED!=='true'||process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED!=='true'){
    res.status(404).json({success:false,message:'Skills Miner is disabled'});return;
  }
  const id=req.params.id,username=(req as any).user?.username,keyId=req.query.keyId??null,cursor=req.query.beforeRevision;
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||
    typeof username!=='string'||!username||(keyId!==null&&(typeof keyId!=='string'||!keyId||keyId.length>255))||
    (cursor!==undefined&&(typeof cursor!=='string'||!/^\d+$/.test(cursor)||!Number.isSafeInteger(Number(cursor))||Number(cursor)<1||Number(cursor)>2147483647))){
    res.status(400).json({success:false,message:'Invalid version cursor or skill scope'});return;
  }
  try{
    const data=await readSkillVersions(id,{username,keyId:keyId as string|null},cursor===undefined?undefined:Number(cursor));
    if(!data){res.status(404).json({success:false,message:'Skill not found'});return;}
    res.setHeader('Cache-Control','no-store');res.json({success:true,data});
  }catch{res.status(503).json({success:false,message:'Skill versions are unavailable'});}
}
