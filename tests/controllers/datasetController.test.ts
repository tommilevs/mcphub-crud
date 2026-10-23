import type {Request,Response} from 'express';
const query=jest.fn();
jest.mock('../../src/db/connection.js',()=>({getAppDataSource:()=>({query})}));
import {previewDataset,exportDataset} from '../../src/controllers/datasetController.js';
const id='af3e4f22-cd76-4b99-8cf7-52db210e54de';
const response=()=>({status:jest.fn().mockReturnThis(),json:jest.fn(),setHeader:jest.fn(),send:jest.fn()});
const original=process.env.MCPHUB_DATASET_BUILDER_ENABLED;
beforeEach(()=>{query.mockReset();process.env.MCPHUB_DATASET_BUILDER_ENABLED='true';});
afterAll(()=>{if(original===undefined)delete process.env.MCPHUB_DATASET_BUILDER_ENABLED;else process.env.MCPHUB_DATASET_BUILDER_ENABLED=original;});
test('requires admin and explicit feature enablement',async()=>{
  const denied=response();await previewDataset({user:{isAdmin:false}} as Request,denied as unknown as Response);
  expect(denied.status).toHaveBeenCalledWith(403);
  delete process.env.MCPHUB_DATASET_BUILDER_ENABLED;
  const disabled=response();await previewDataset({user:{isAdmin:true}} as Request,disabled as unknown as Response);
  expect(disabled.status).toHaveBeenCalledWith(404);expect(query).not.toHaveBeenCalled();
});
test.each([{resultIds:[]},{resultIds:['bad']},{resultIds:[id],allowSelfReported:'true'},
  {resultIds:[id],format:'dpo'},{resultIds:[id],split:'all'}])('rejects invalid or unsupported export %s',async body=>{
  const res=response();await exportDataset({user:{isAdmin:true,username:'owner'},body} as Request,res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(400);expect(query).not.toHaveBeenCalled();
});
test('scope is authenticated owner and explicit key, missing IDs are not existence leaks',async()=>{
  query.mockResolvedValue([]);const res=response();
  await previewDataset({user:{isAdmin:true,username:'owner'},body:{resultIds:[id],keyId:'own-key'}} as Request,res as unknown as Response);
  expect(query.mock.calls[0][1]).toEqual([[id],'owner','own-key']);
  expect(res.json.mock.calls[0][0].data.excluded).toEqual({unavailable_or_out_of_scope:1});
});
