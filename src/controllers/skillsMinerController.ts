import type {Request,Response} from 'express';
import {requireAdmin} from '../utils/requireAdmin.js';
import {previewSkillFromExperience} from '../services/skillProposalService.js';
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
