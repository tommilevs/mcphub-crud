export interface ExperienceEvidence {resultId:string;taskId:string|null;payloadAvailable:boolean;rawSha256:string|null;
  reviewDigest:string|null;quality:string;privacy:string;outcome:string}
/** Counts independent reviewed tasks, never execution status as task success. */
export function assessExperienceEvidence(ids:string[],rows:ExperienceEvidence[]){
  const sources=new Map(rows.map(row=>[row.resultId,row]));
  const tasks=new Set<string>();
  let invalid=0;
  for(const id of new Set(ids)){
    const row=sources.get(id);
    if(!row||!row.taskId||!row.payloadAvailable||!row.rawSha256||row.rawSha256!==row.reviewDigest||
      row.quality!=='correct'||row.privacy!=='approved'||row.outcome!=='success'){invalid++;continue;}
    tasks.add(row.taskId);
  }
  return {usable:ids.length>0&&invalid===0,confidence:tasks.size>=2?'supported':'hypothesis',
    independentTasks:tasks.size,invalidEvidence:invalid,outcomeSource:'user_confirmed'};
}
