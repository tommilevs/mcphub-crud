import {searchExperiences} from './experienceMemory.js';
export interface ExperienceAdvice {
  experienceId:string;revision:number;evidenceResultIds:string[];confidence:string;
  title?:string;summary?:string;
}
/** Optional, owner-scoped advice; never changes permissions or provides an execution callback. */
export async function getExperienceAdvice(value:{username?:string;keyId?:string;server:string;tool:string;taskType?:string}):Promise<ExperienceAdvice[]>{
  if(process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED!=='true'||process.env.MCPHUB_EXPERIENCE_ADVICE_ENABLED!=='true'||!value.username)return [];
  try{
    const entries=await searchExperiences({username:value.username,keyId:value.keyId??null,query:value.tool,
      server:value.server,tool:value.tool,limit:3});
    // Runtime has no independently observed tool version: do not assume compatibility.
    return entries.filter((entry:any)=>entry.tool_versions&&typeof entry.tool_versions==='object'&&!Array.isArray(entry.tool_versions)&&Object.keys(entry.tool_versions).length===0&&
      (entry.task_type==='general'||(value.taskType&&entry.task_type===value.taskType))).map((entry:any)=>({
      experienceId:entry.experience_id,revision:entry.revision,evidenceResultIds:entry.evidence_ids,
      confidence:entry.assessment.confidence,title:entry.title,summary:entry.summary}));
  }catch{return [];}
}
