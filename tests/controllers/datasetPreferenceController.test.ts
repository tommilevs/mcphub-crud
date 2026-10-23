import type {Request,Response} from 'express';
jest.mock('../../src/db/connection.js',()=>({getAppDataSource:()=>({query:jest.fn()})}));
jest.mock('../../src/services/datasetPreference.js',()=>({createPreference:jest.fn(),listPreferences:jest.fn(),reviewPreference:jest.fn()}));
import {manageDatasetPreferences} from '../../src/controllers/datasetPreferenceController.js';
import {createPreference,reviewPreference} from '../../src/services/datasetPreference.js';
const a='af3e4f22-cd76-4b99-8cf7-52db210e54de',b='bf3e4f22-cd76-4b99-8cf7-52db210e54de';
const flags=[process.env.MCPHUB_DPO_ENABLED,process.env.MCPHUB_DATASET_BUILDER_ENABLED];
const response=()=>({status:jest.fn().mockReturnThis(),json:jest.fn(),setHeader:jest.fn()});
const req=(value:object)=>({method:'POST',user:{isAdmin:true,username:'owner'},params:{id:a},query:{},body:{},...value}) as unknown as Request;
beforeEach(()=>{jest.resetAllMocks();process.env.MCPHUB_DPO_ENABLED='true';process.env.MCPHUB_DATASET_BUILDER_ENABLED='true';});
afterAll(()=>{['MCPHUB_DPO_ENABLED','MCPHUB_DATASET_BUILDER_ENABLED'].forEach((key,index)=>{if(flags[index]===undefined)delete process.env[key];else process.env[key]=flags[index];});});
test('requires explicit comparability and separately confirmed approval, never an HTTP-derived label',async()=>{
  const res=response();await manageDatasetPreferences(req({body:{chosenId:a,rejectedId:b,rationale:'HTTP 200 vs 500'}}),res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(400);expect(createPreference).not.toHaveBeenCalled();
  const approval=response();await manageDatasetPreferences(req({method:'PATCH',body:{revision:1,status:'approved',comparabilityConfirmed:true}}),approval as unknown as Response);
  expect(approval.status).toHaveBeenCalledWith(400);expect(reviewPreference).not.toHaveBeenCalled();
});
test('uses authenticated owner/key and creates a draft through the source-checking service',async()=>{
  (createPreference as jest.Mock).mockResolvedValue({status:'draft',privacy_approved:false});
  const res=response();await manageDatasetPreferences(req({body:{chosenId:a,rejectedId:b,rationale:'Compared actual actions',comparabilityConfirmed:true,keyId:'own',username:'victim'}}),res as unknown as Response);
  expect(createPreference).toHaveBeenCalledWith(expect.anything(),{username:'owner',keyId:'own',allowSelfReported:false},
    {chosenId:a,rejectedId:b,rationale:'Compared actual actions'});
  expect(res.json).toHaveBeenCalledWith({success:true,data:{status:'draft',privacy_approved:false}});
});
test('source/revision conflicts return 409 and explicit activation remains required',async()=>{
  (reviewPreference as jest.Mock).mockResolvedValue(null);
  const res=response();await manageDatasetPreferences(req({method:'PATCH',body:{revision:1,status:'approved',comparabilityConfirmed:true,privacyApproved:true}}),res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(409);
  delete process.env.MCPHUB_DPO_ENABLED;const disabled=response();await manageDatasetPreferences(req({method:'GET'}),disabled as unknown as Response);
  expect(disabled.status).toHaveBeenCalledWith(404);
});
