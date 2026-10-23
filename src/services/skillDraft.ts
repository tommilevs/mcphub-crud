interface SkillDraftInput {
  title:string;taskType:string;steps:Array<{server:string;tool:string}>;evidenceResultIds:string[];
  independentTasks:number;modelObservations:Array<{modelId:string|null;source:string}>;reportedToolVersions:Record<string,string>;
}
const plain=(value:string)=>value.replace(/[\r\n]+/g,' ').replace(/---/g,'—').replace(/[<>`]/g,'').slice(0,1024);
/** A review artifact, not an installation instruction or verified generalized skill. */
export function renderSkillDraft(value:SkillDraftInput):string{
  const lines=[
    '---','name: mcphub-workflow-proposal',`description: ${JSON.stringify(plain(value.title))}`,'---','',
    `# ${plain(value.title)}`,'','Status: draft — requires human review before export or installation.','',
    '## Prerequisites','- Confirm the required servers/tools are available and authorized.',
    '- Inspect the linked evidence and adapt arguments to the current task; no arguments are inferred here.','',
    '## Applicability',`Task category (reviewer-reported): ${plain(value.taskType)}.`,
    'The observed scope does not establish applicability to other systems or task categories.','',
    '## Steps',...value.steps.map((step,index)=>`${index+1}. Consider ${plain(step.server)}/${plain(step.tool)} after checking the current state.`),'',
    '## Safety','- This proposal grants no tool permissions and must not execute or install itself.',
    '- Obtain authorization for side effects; intentional polling, waits and retries may be legitimate.',
    '- Stop and reassess if current evidence differs from the source workflows.','',
    '## Evidence',`Repeated temporal sequence across ${value.independentTasks} independently reviewed task IDs.`,
    'Task outcomes are user-confirmed; temporal order is not proof of causal necessity.',
    ...value.evidenceResultIds.map(id=>`- result_id: ${plain(id)}`),'',
    '## Versions',...(Object.keys(value.reportedToolVersions).length?
      Object.entries(value.reportedToolVersions).map(([tool,version])=>`- Reported constraint: ${plain(tool)} = ${plain(version)} (not independently observed).`):
      ['Unknown — verify tool/server versions before using this proposal.']),'',
    '## Limitations','- A repeated sequence is a candidate, not a guarantee of generalization.',
    '- Original RAW and arguments are not embedded. Recheck source availability and privacy approval.',
    '- Model/client bias has not been statistically evaluated.',
    ...value.modelObservations.map(model=>`- Model observation: ${plain(model.modelId??'Unknown')} (source: ${plain(model.source)}).`),'',
  ];
  return lines.join('\n');
}
