import {getToolResultRepository} from './toolResultHistoryRegistry.js';
import {generateEmbedding} from './vectorSearchService.js';
import type {ToolResultChunkHit} from '../types/toolResult.js';
/** Reuse the retained result index. No embedding call while async indexing is pending. */
export async function loadResultSemanticCandidates(resultId:string,objective:string):Promise<ToolResultChunkHit[]>{
 const repository=getToolResultRepository();
 if(!repository?.listChunks||!repository.searchChunks)return [];
 const chunks=await repository.listChunks(resultId);
 if(!chunks.some(chunk=>chunk.hasEmbedding))return [];
 const embedding=await generateEmbedding(objective,'query');
 const hits=await repository.searchChunks(resultId,objective,embedding,20);
 return hits.filter(hit=>hit.resultId===resultId&&typeof hit.vectorRank==='number').sort((a,b)=>a.vectorRank!-b.vectorRank!);
}
