jest.mock('../../src/db/connection.js',()=>({getAppDataSource:jest.fn()}));
jest.mock('../../src/services/skillProposalService.js',()=>({previewSkillFromExperience:jest.fn()}));
import {getAppDataSource} from '../../src/db/connection.js';
import {previewSkillFromExperience} from '../../src/services/skillProposalService.js';
import {reviseSkillProposal,exportSkillProposal,readSkillVersions} from '../../src/services/storedSkillProposals.js';
const owner={username:'alice',keyId:null};
const proposal={revision:1,status:'approved',source_experience_id:'source',source_revision:2,markdown:'reviewed',source_snapshot:{candidate:{workflowSignature:'sequence'}}};
const query=jest.fn();
beforeEach(()=>{jest.resetAllMocks();(getAppDataSource as jest.Mock).mockReturnValue({query});});
test('approval rejects edited content and stale evidence without storing a revision',async()=>{
  query.mockResolvedValue([proposal]);
  expect(await reviseSkillProposal('id',owner,{revision:1,status:'approved',markdown:'changed'})).toBeNull();
  expect(await reviseSkillProposal('id',owner,{revision:1,status:'approved'})).toBeNull();
  expect(query).toHaveBeenCalledTimes(2);
});
test('edits always reset approval and bind SQL update to the requested owner and revision',async()=>{
  query.mockResolvedValueOnce([proposal]).mockResolvedValueOnce([{snapshot:{status:'draft',revision:2}}]);
  expect(await reviseSkillProposal('id',owner,{revision:1,status:'draft',markdown:'changed'})).toEqual({status:'draft',revision:2});
  expect(query.mock.calls[1][1]).toEqual(['id','alice',null,1,'changed','draft']);
});
test('export refuses stale sources, drafts and concurrent retirement',async()=>{
  query.mockResolvedValue([proposal]);
  expect(await exportSkillProposal('id',owner)).toBeNull();
  (previewSkillFromExperience as jest.Mock).mockResolvedValue({sourceExperienceRevision:2,candidate:{workflowSignature:'sequence'}});
  query.mockResolvedValueOnce([proposal]).mockResolvedValueOnce([{...proposal,status:'retired',revision:2}]);
  expect(await exportSkillProposal('id',owner)).toBeNull();
  query.mockResolvedValue([{...proposal,status:'draft'}]);
  expect(await exportSkillProposal('id',owner)).toBeNull();
});
test('version reader is owner scoped and uses a bounded descending revision cursor',async()=>{
  query.mockResolvedValueOnce([]);
  expect(await readSkillVersions('id',owner)).toBeNull();
  query.mockResolvedValueOnce([proposal]).mockResolvedValueOnce(Array.from({length:11},(_,index)=>({revision:20-index,snapshot:{markdown:`version ${20-index}`}})));
  const page=await readSkillVersions('id',owner,21);
  expect(page?.versions).toHaveLength(10);expect(page?.nextBeforeRevision).toBe(11);
  expect(query.mock.calls[2][1]).toEqual(['id','alice',null,21]);
});
