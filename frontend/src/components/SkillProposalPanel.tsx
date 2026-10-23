import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {createSkill,listSkills,reviseSkill,downloadSkill,readSkillVersions,type SkillProposal,type SkillVersion} from '@/services/skillService';

function SkillEditor({entry,keyId,busy,perform,refresh}:{entry:SkillProposal;keyId:string;busy:boolean;
  perform:(action:()=>Promise<void>)=>Promise<void>;refresh:()=>Promise<void>}){
  const {t}=useTranslation();
  const [markdown,setMarkdown]=useState(entry.markdown),[reviewed,setReviewed]=useState(false);
  const [versions,setVersions]=useState<SkillVersion[]>(),[cursor,setCursor]=useState<number|null>(null);
  const loadVersions=async(append=false)=>{
    const response=await readSkillVersions(entry.proposal_id,keyId,append?cursor??undefined:undefined);
    if(!response.success||!response.data)throw new Error(response.message||t('app.error'));
    setVersions(append?[...(versions??[]),...response.data.versions]:response.data.versions);setCursor(response.data.nextBeforeRevision);
  };
  const dirty=markdown!==entry.markdown;
  const update=async(status:string,edit=false)=>{
    const response=await reviseSkill(entry.proposal_id,{revision:entry.revision,status,...(edit?{markdown}:{})},keyId);
    if(!response.success)throw new Error(response.message||t('app.error'));
    setReviewed(false);await refresh();
  };
  return <article className="space-y-2 border-t border-[var(--hub-line)] pt-3">
    <p className="text-xs">{t(`experiences.status.${entry.status}`,entry.status)} · #{entry.revision} · {entry.reviewed_by}</p>
    <label className="block text-xs">{t('skills.markdown','Skill draft (Markdown)')}
      <textarea className="hub-input mt-1 w-full font-mono text-xs" rows={14} maxLength={65536} value={markdown} disabled={busy}
        onChange={event=>{setMarkdown(event.target.value);setReviewed(false);}}/>
    </label>
    <p className="text-xs text-[var(--hub-ink-3)]">{t('skills.reviewHelp','Check prerequisites, safety, privacy, evidence and applicability. Saving an edit removes approval. Export checks the source again and never installs the skill.')}</p>
    <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={reviewed} disabled={busy||dirty}
      onChange={event=>setReviewed(event.target.checked)}/>{t('skills.reviewed','I reviewed this exact saved revision for export.')}</label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="hub-btn" disabled={busy||!dirty||!markdown.trim()} onClick={()=>perform(()=>update('draft',true))}>{t('skills.saveDraft','Save draft')}</button>
      <button type="button" className="hub-btn" disabled={busy||dirty||!reviewed||entry.status==='approved'} onClick={()=>perform(()=>update('approved'))}>{t('skills.approve','Approve revision')}</button>
      <button type="button" className="hub-btn" disabled={busy||dirty||entry.status!=='approved'} onClick={()=>perform(async()=>{
        const blob=await downloadSkill(entry.proposal_id,keyId),url=URL.createObjectURL(blob);
        const link=document.createElement('a');link.href=url;link.download='SKILL.md';link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      })}>{t('skills.download','Download SKILL.md')}</button>
      <button type="button" className="hub-btn" disabled={busy||entry.status==='retired'} onClick={()=>perform(()=>update('retired'))}>{t('experiences.actions.retired','Retire')}</button>
      <button type="button" className="hub-btn" disabled={busy} onClick={()=>perform(()=>loadVersions())}>{t('skills.versions','View saved versions')}</button>
    </div>
    {versions&&<div className="space-y-2">
      <p className="text-xs text-[var(--hub-ink-3)]">{t('skills.historyHelp','Historical snapshots are read-only. Past approval does not authorize exporting an old version; export always checks the current proposal and evidence.')}</p>
      {versions.map(version=><details key={version.revision} className="rounded border border-[var(--hub-line)] p-2 text-xs">
        <summary>#{version.revision} · {version.status} · {version.reviewedBy} · {new Date(version.reviewedAt).toLocaleString()}</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words">{version.markdown}</pre>
      </details>)}
      {cursor!==null&&<button type="button" className="hub-btn" disabled={busy} onClick={()=>perform(()=>loadVersions(true))}>{t('skills.moreVersions','Load earlier versions')}</button>}
    </div>}
  </article>;
}

/** Mount with an owner/key/source key so stale async results never cross scopes. */
export default function SkillProposalPanel({experienceId,keyId}:{experienceId:string;keyId:string}){
  const {t}=useTranslation();
  const [open,setOpen]=useState(false),[rows,setRows]=useState<SkillProposal[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const refresh=async()=>{
    const response=await listSkills(keyId);
    if(!response.success||!response.data)throw new Error(response.message||t('app.error'));
    setRows(response.data.filter(entry=>entry.source_experience_id===experienceId));
  };
  const perform=async(action:()=>Promise<void>)=>{
    setBusy(true);setError('');try{await action();}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
  };
  return <section className="space-y-3">
    <button type="button" className="hub-btn" disabled={busy} aria-expanded={open} onClick={()=>{
      setOpen(!open);if(!open)void perform(refresh);
    }}>{t('skills.title','Skills Miner')}</button>
    {open&&<div className="space-y-3">
      <p className="text-xs">{t('skills.help','Draft a skill from at least two independently reviewed matching workflows. A proposal is not proof of a general solution.')}</p>
      <button type="button" className="hub-btn" disabled={busy} onClick={()=>perform(async()=>{
        const response=await createSkill(experienceId,keyId);
        if(!response.success)throw new Error(response.message||t('app.error'));
        await refresh();
      })}>{t('skills.create','Create workflow draft')}</button>
      <button type="button" className="hub-btn ml-2" disabled={busy} onClick={()=>perform(refresh)}>{t('experiences.refresh','Load my proposals')}</button>
      {rows.map(entry=><SkillEditor key={`${entry.proposal_id}:${entry.revision}`} entry={entry} keyId={keyId} busy={busy} perform={perform} refresh={refresh}/>)}
    </div>}
    {error&&<p role="alert" className="text-xs text-red-500">{error}</p>}
  </section>;
}
