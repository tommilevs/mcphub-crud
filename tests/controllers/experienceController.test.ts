import type {Request,Response} from 'express';
const query=jest.fn();
jest.mock('../../src/db/connection.js',()=>({getAppDataSource:()=>({query})}));
import {saveExperience,findExperiences,reviewExperience,listExperiences,readExperience,getExperienceAvailability} from '../../src/controllers/experienceController.js';
const response=()=>({status:jest.fn().mockReturnThis(),json:jest.fn()});
const old=process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED;
beforeEach(()=>{query.mockReset();process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED='true';});
afterAll(()=>{if(old===undefined)delete process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED;else process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED=old;});
test('requires admin and explicit activation',async()=>{
  const denied=response();await findExperiences({user:{isAdmin:false}} as Request,denied as unknown as Response);
  expect(denied.status).toHaveBeenCalledWith(403);
  delete process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED;
  const disabled=response();await findExperiences({user:{isAdmin:true,username:'owner'}} as Request,disabled as unknown as Response);
  expect(disabled.status).toHaveBeenCalledWith(404);expect(query).not.toHaveBeenCalled();
});
test('rejects invalid proposal, search and review before database access',async()=>{
  const input={user:{isAdmin:true,username:'owner'},body:{},params:{id:'bad'},query:{limit:'100'}} as unknown as Request;
  for(const handler of [saveExperience,findExperiences,reviewExperience]){
    const res=response();await handler(input,res as unknown as Response);expect(res.status).toHaveBeenCalledWith(400);
  }
  expect(query).not.toHaveBeenCalled();
});
test('governance list is owner-scoped and current lookup never returns a missing strategy',async()=>{
  query.mockResolvedValue([]);const res=response();
  await listExperiences({user:{isAdmin:true,username:'owner'},query:{keyId:'own-key'}} as unknown as Request,res as unknown as Response);
  expect(query.mock.calls[0][1]).toEqual(['owner','own-key',null,20,null]);
  const missing=response();await readExperience({user:{isAdmin:true,username:'owner'},query:{},params:{id:'af3e4f22-cd76-4b99-8cf7-52db210e54de'}} as unknown as Request,missing as unknown as Response);
  expect(missing.status).toHaveBeenCalledWith(404);
});
test('availability needs no source query',async()=>{
  const res=response();await getExperienceAvailability({user:{isAdmin:true}} as Request,res as unknown as Response);
  expect(res.json).toHaveBeenCalledWith({success:true,data:{enabled:true}});expect(query).not.toHaveBeenCalled();
});
