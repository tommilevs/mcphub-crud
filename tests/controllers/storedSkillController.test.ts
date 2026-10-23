import type {Request,Response} from 'express';
jest.mock('../../src/services/storedSkillProposals.js',()=>({createSkillProposal:jest.fn(),listSkillProposals:jest.fn(),reviseSkillProposal:jest.fn(),exportSkillProposal:jest.fn()}));
import {manageSkillProposals} from '../../src/controllers/skillsMinerController.js';
import {exportSkillProposal,reviseSkillProposal,listSkillProposals} from '../../src/services/storedSkillProposals.js';
const id='af3e4f22-cd76-4b99-8cf7-52db210e54de';
const old=[process.env.MCPHUB_SKILLS_MINER_ENABLED,process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED];
const response=()=>({status:jest.fn().mockReturnThis(),json:jest.fn(),send:jest.fn(),setHeader:jest.fn()});
const request=(value:object)=>({method:'POST',user:{isAdmin:true,username:'owner'},params:{id},query:{},body:{keyId:'own-key',username:'other-owner'},...value}) as unknown as Request;
beforeEach(()=>{jest.resetAllMocks();process.env.MCPHUB_SKILLS_MINER_ENABLED='true';process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED='true';});
afterAll(()=>{for(const [index,key] of ['MCPHUB_SKILLS_MINER_ENABLED','MCPHUB_EXPERIENCE_MEMORY_ENABLED'].entries()){
  if(old[index]===undefined)delete process.env[key];else process.env[key]=old[index];
}});
test('export sends only approved current Markdown in authenticated owner scope',async()=>{
  (exportSkillProposal as jest.Mock).mockResolvedValue({markdown:'# Reviewed skill'});
  const res=response();await manageSkillProposals(request({}),res as unknown as Response);
  expect(exportSkillProposal).toHaveBeenCalledWith(id,{username:'owner',keyId:'own-key'});
  expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition','attachment; filename="SKILL.md"');
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control','no-store');expect(res.send).toHaveBeenCalledWith('# Reviewed skill');
});
test('stale export returns conflict without a file, and edits cannot approve in one request',async()=>{
  (exportSkillProposal as jest.Mock).mockResolvedValue(null);
  const res=response();await manageSkillProposals(request({}),res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(409);expect(res.send).not.toHaveBeenCalled();
  const edit=response();await manageSkillProposals(request({method:'PATCH',body:{revision:1,status:'approved',markdown:'changed'}}),edit as unknown as Response);
  expect(edit.status).toHaveBeenCalledWith(400);expect(reviseSkillProposal).not.toHaveBeenCalled();
});
test('disabled and nonadmin requests never reach storage, and key scope is not widened',async()=>{
  const denied=response();await manageSkillProposals(request({user:{isAdmin:false}}),denied as unknown as Response);
  expect(denied.status).toHaveBeenCalledWith(403);
  delete process.env.MCPHUB_SKILLS_MINER_ENABLED;
  const disabled=response();await manageSkillProposals(request({}),disabled as unknown as Response);
  expect(disabled.status).toHaveBeenCalledWith(404);expect(exportSkillProposal).not.toHaveBeenCalled();
  process.env.MCPHUB_SKILLS_MINER_ENABLED='true';(listSkillProposals as jest.Mock).mockResolvedValue([]);
  await manageSkillProposals(request({method:'GET',params:{},query:{keyId:'specific'}}),response() as unknown as Response);
  expect(listSkillProposals).toHaveBeenCalledWith({username:'owner',keyId:'specific'},undefined);
});
