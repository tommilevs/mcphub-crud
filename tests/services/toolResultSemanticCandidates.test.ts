const mockRepository=jest.fn(),mockEmbedding=jest.fn();
jest.mock('../../src/services/toolResultHistoryRegistry.js',()=>({getToolResultRepository:mockRepository}));
jest.mock('../../src/services/vectorSearchService.js',()=>({generateEmbedding:mockEmbedding}));
import {loadResultSemanticCandidates} from '../../src/services/toolResultSemanticCandidates.js';
beforeEach(()=>jest.resetAllMocks());
it('does not spend embedding tokens before an index is ready',async()=>{
 mockRepository.mockReturnValue({listChunks:async()=>[{hasEmbedding:false}],searchChunks:jest.fn()});
 expect(await loadResultSemanticCandidates('id','query')).toEqual([]);expect(mockEmbedding).not.toHaveBeenCalled();
});
it('uses existing vectors and returns only vector candidates for the saved result',async()=>{
 const searchChunks=jest.fn().mockResolvedValue([{resultId:'id',content:'source',vectorRank:1},{resultId:'foreign',content:'foreign',vectorRank:2},{resultId:'id',content:'lexical',lexicalRank:1}]);
 mockRepository.mockReturnValue({listChunks:async()=>[{hasEmbedding:true}],searchChunks});mockEmbedding.mockResolvedValue([1,0]);
 expect(await loadResultSemanticCandidates('id','query')).toEqual([{resultId:'id',content:'source',vectorRank:1}]);
 expect(searchChunks).toHaveBeenCalledWith('id','query',[1,0],20);
});
