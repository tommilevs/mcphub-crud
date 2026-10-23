import type { Request, Response } from 'express';
const query=jest.fn();
jest.mock('../../src/db/connection.js',()=>({getAppDataSource:()=>({query})}));
import { getTrainingContext } from '../../src/controllers/trainingContextController.js';
const id='af3e4f22-cd76-4b99-8cf7-52db210e54de';
const response=()=>({status:jest.fn().mockReturnThis(),json:jest.fn()});
beforeEach(()=>query.mockReset());
test('loads latest reviewed context and bounded source events for an existing result',async()=>{
  const data={current:null,sources:[]};query.mockResolvedValue([{data}]);
  const res=response();
  await getTrainingContext({user:{isAdmin:true},params:{id}} as unknown as Request,res as unknown as Response);
  expect(query.mock.calls[0][1]).toEqual([id]);
  expect(res.json).toHaveBeenCalledWith({success:true,data});
});
test('rejects invalid IDs and non-admins without querying',async()=>{
  for(const request of [{user:{isAdmin:true},params:{id:'bad'}},{user:{isAdmin:false},params:{id}}]){
    const res=response();await getTrainingContext(request as unknown as Request,res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(request.user.isAdmin?400:403);
  }
  expect(query).not.toHaveBeenCalled();
});
test('reports unavailable result and database without exposing context data',async()=>{
  query.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline'));
  for(const status of [404,503]){
    const res=response();await getTrainingContext({user:{isAdmin:true},params:{id}} as unknown as Request,res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(status);
  }
});
