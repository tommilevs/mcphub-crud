import type {Request,Response} from 'express';
const preview=jest.fn();
jest.mock('../../src/services/skillProposalService.js',()=>({previewSkillFromExperience:(...args:any[])=>preview(...args)}));
import {previewSkillProposal} from '../../src/controllers/skillsMinerController.js';
const response=()=>({status:jest.fn().mockReturnThis(),json:jest.fn()});
const original=[process.env.MCPHUB_SKILLS_MINER_ENABLED,process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED];
beforeEach(()=>{preview.mockReset();process.env.MCPHUB_SKILLS_MINER_ENABLED='true';process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED='true';});
afterAll(()=>{for(const [index,name] of ['MCPHUB_SKILLS_MINER_ENABLED','MCPHUB_EXPERIENCE_MEMORY_ENABLED'].entries()){
  if(original[index]===undefined)delete process.env[name];else process.env[name]=original[index];}});
test('requires admin and explicit activation',async()=>{
  const denied=response();await previewSkillProposal({user:{isAdmin:false}} as Request,denied as unknown as Response);
  expect(denied.status).toHaveBeenCalledWith(403);
  delete process.env.MCPHUB_SKILLS_MINER_ENABLED;
  const disabled=response();await previewSkillProposal({user:{isAdmin:true}} as Request,disabled as unknown as Response);
  expect(disabled.status).toHaveBeenCalledWith(404);expect(preview).not.toHaveBeenCalled();
});
test('rejects invalid IDs and passes authenticated scope, never an owner from the body',async()=>{
  const invalid=response();await previewSkillProposal({user:{isAdmin:true,username:'owner'},body:{experienceId:'bad'}} as Request,invalid as unknown as Response);
  expect(invalid.status).toHaveBeenCalledWith(400);
  preview.mockResolvedValue(null);const missing=response(),id='af3e4f22-cd76-4b99-8cf7-52db210e54de';
  await previewSkillProposal({user:{isAdmin:true,username:'owner'},body:{experienceId:id,username:'other'}} as Request,missing as unknown as Response);
  expect(preview).toHaveBeenCalledWith(id,'owner',null);expect(missing.status).toHaveBeenCalledWith(409);
});
