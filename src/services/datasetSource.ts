import type {DatasetCall} from './datasetBuilder.js';
export async function loadDatasetCalls(db:{query(sql:string,parameters?:any[]):Promise<any[]>},ids:string[],username:string,keyId:string|null,trajectory=false):Promise<DatasetCall[]>{
    const rows=await db.query(`SELECT result.result_id,result.username,result.key_id,result.attribution,result.timestamp,result.status,
      CASE WHEN $4::boolean THEN (SELECT count(*) FROM tool_results member WHERE member.username=result.username AND member.key_id IS NOT DISTINCT FROM result.key_id
        AND member.attribution->>'taskId'=result.attribution->>'taskId' AND member.attribution->>'traceId'=result.attribution->>'traceId'
        AND member.attribution->>'branchId'=result.attribution->>'branchId' AND member.attribution->>'modelSegmentId'=result.attribution->>'modelSegmentId') ELSE NULL END AS retained_segment_calls,
      result.payload_available,result.raw_sha256,result.objective,result.arguments,
      task.outcome,task.training_consent,task.revision AS task_revision,
      review.quality,review.privacy,review.raw_sha256 AS review_digest,review.revision AS review_revision,
      context.tool_catalogue,context.privacy_approved,context.revision AS context_revision
      FROM tool_results result
      LEFT JOIN LATERAL(SELECT * FROM attribution_task_reviews WHERE task_id::text=result.attribution->>'taskId' ORDER BY revision DESC LIMIT 1) task ON TRUE
      LEFT JOIN LATERAL(SELECT * FROM tool_result_reviews WHERE result_id=result.result_id ORDER BY revision DESC LIMIT 1) review ON TRUE
      LEFT JOIN LATERAL(SELECT * FROM tool_result_training_contexts WHERE result_id=result.result_id ORDER BY revision DESC LIMIT 1) context ON TRUE
      WHERE result.result_id=ANY($1::uuid[]) AND result.username=$2 AND result.key_id IS NOT DISTINCT FROM $3`,[ids,username,keyId,trajectory]);
    const calls:DatasetCall[]=rows.map((row:any)=>({resultId:row.result_id,username:row.username,keyId:row.key_id,
      taskId:row.attribution?.taskId??null,traceId:row.attribution?.traceId??null,branchId:row.attribution?.branchId??null,callId:row.attribution?.callId??null,
      segmentId:row.attribution?.modelSegmentId??null,modelId:row.attribution?.identity?.modelId??null,
      source:row.attribution?.identity?.source??'unknown',verified:row.attribution?.identity?.verified===true,
      causal:row.attribution?.provenance?.causalCorrelationVerified===true,conflict:Boolean(row.attribution?.conflictReason),
      payloadAvailable:row.payload_available===true,rawSha256:row.raw_sha256,objective:row.objective,
      toolName:row.attribution?.invokedToolName??null,arguments:row.arguments,tools:row.tool_catalogue??[],
      consent:row.training_consent===true,outcome:row.outcome??'unknown',quality:row.quality??'unknown',
      privacy:row.privacy==='approved',contextPrivacy:row.privacy_approved===true,reviewDigest:row.review_digest,
      reviewRevision:row.review_revision??0,contextRevision:row.context_revision??0,taskRevision:row.task_revision??0,
      timestamp:row.timestamp?new Date(row.timestamp).toISOString():undefined,status:row.status,retainedSegmentCalls:Number(row.retained_segment_calls)}));
    return calls;
}
