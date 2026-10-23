import {useEffect,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Link} from 'react-router-dom';
import {getExperienceAvailability,listExperiences,saveExperience,reviewExperience,type ExperienceEntry} from '@/services/experienceService';

function ExperienceManager({resultIds}:{resultIds:string[]}){
  const {t}=useTranslation();
  const [enabled,setEnabled]=useState<boolean>();
  const [keyId,setKeyId]=useState(''),[query,setQuery]=useState('');
  const [title,setTitle]=useState(''),[summary,setSummary]=useState(''),[taskType,setTaskType]=useState('general');
  const [servers,setServers]=useState(''),[tools,setTools]=useState(''),[approved,setApproved]=useState(false);
  const [listing,setListing]=useState<{key:string;rows:ExperienceEntry[]}>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [message,setMessage]=useState('');
  const evidenceKey=JSON.stringify([...resultIds].sort());
  useEffect(()=>{setApproved(false);},[evidenceKey]);
  const scopeKey=keyId.trim();
  const rows=listing?.key===scopeKey?listing.rows:[];
  useEffect(()=>{
    let active=true;
    getExperienceAvailability().then(response=>{if(active){if(response.success)setEnabled(response.data?.enabled??false);else setError(response.message||t('app.error'));}})
      .catch(reason=>{if(active)setError(String(reason));});
    return()=>{active=false;};
  },[]);
  const refresh=async()=>{
    const response=await listExperiences(scopeKey,query);
    if(!response.success||!response.data)throw new Error(response.message||t('app.error'));
    setListing({key:scopeKey,rows:response.data});
  };
  const perform=async(action:()=>Promise<void>)=>{
    setBusy(true);setError('');setMessage('');try{await action();}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
  };
  const changeStatus=async(entry:ExperienceEntry,status:string)=>{
    const response=await reviewExperience(entry.experience_id,entry.revision,status,scopeKey);
    if(!response.success)throw new Error(response.message||t('app.error'));
    await refresh();
  };
  if(enabled===undefined)return <p role={error?'alert':undefined} className="text-xs">{error||t('app.loading')}</p>;
  if(!enabled)return <p className="text-xs">{t('experiences.disabled','Experience Memory is disabled.')}</p>;
  return <div className="space-y-4">
    <p className="text-xs text-[var(--hub-ink-3)]">{t('experiences.help','Reviewed strategy proposals from your own evidence. One task remains a hypothesis; multiple reviewed tasks do not prove generalization. Nothing is executed or installed.')}</p>
    <label className="block text-xs">{t('datasets.keyScope','API key ID (blank for calls without a key; never enter a token)')}
      <input className="hub-input mt-1 w-full" value={keyId} disabled={busy} onChange={event=>{setKeyId(event.target.value);setApproved(false);}}/>
    </label>
    <form className="space-y-3 border-t border-[var(--hub-line)] pt-3" onSubmit={event=>{event.preventDefault();void perform(async()=>{
      const lines=(value:string)=>value.split('\n').map(item=>item.trim()).filter(Boolean);
      const response=await saveExperience({title,summary,taskType,keyId:scopeKey||null,evidenceIds:resultIds,approved,
        scope:{servers:lines(servers),tools:lines(tools)},toolVersions:{}});
      if(!response.success)throw new Error(response.message||t('app.error'));
      setApproved(false);setTitle('');setSummary('');await refresh();setMessage(t('experiences.saved','Proposal saved.'));
    });}}>
      <h3 className="text-sm font-medium">{t('experiences.create','Propose a strategy')} · {resultIds.length} {t('experiences.selected','selected results')}</h3>
      <p className="text-xs text-[var(--hub-ink-3)]">{t('experiences.selectHelp','Select 1–20 source results in the history table before saving a proposal.')}</p>
      <label className="block text-xs">{t('experiences.name','Title')}<input className="hub-input mt-1 w-full" required maxLength={160} disabled={busy} value={title} onChange={event=>{setTitle(event.target.value);setApproved(false);}}/></label>
      <label className="block text-xs">{t('experiences.summary','Strategy and limitations')}<textarea className="hub-input mt-1 w-full" required maxLength={4000} rows={3} disabled={busy} value={summary} onChange={event=>{setSummary(event.target.value);setApproved(false);}}/></label>
      <label className="block text-xs">{t('experiences.taskType','Task category')}<input className="hub-input mt-1 w-full" required maxLength={255} disabled={busy} value={taskType} onChange={event=>{setTaskType(event.target.value);setApproved(false);}}/></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs">{t('experiences.servers','Server scope (one per line; blank means general)')}<textarea className="hub-input mt-1 w-full" rows={2} value={servers} disabled={busy} onChange={event=>{setServers(event.target.value);setApproved(false);}}/></label>
        <label className="text-xs">{t('experiences.tools','Tool scope (one server/tool per line)')}<textarea className="hub-input mt-1 w-full" rows={2} value={tools} disabled={busy} onChange={event=>{setTools(event.target.value);setApproved(false);}}/></label>
      </div>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={approved} disabled={busy} onChange={event=>setApproved(event.target.checked)}/>{t('experiences.approveNow','I reviewed this proposal and approve it for scoped advice. Otherwise save as a draft.')}</label>
      <button className="hub-btn" type="submit" disabled={busy||!resultIds.length||resultIds.length>20}>{t('common.save')}</button>
    </form>
    <div className="flex flex-wrap gap-2"><input className="hub-input min-w-0 flex-1" aria-label={t('experiences.search','Search approved strategies')} placeholder={t('experiences.search','Search approved strategies')} value={query} disabled={busy} onChange={event=>setQuery(event.target.value)}/>
      <button type="button" className="hub-btn" disabled={busy} onClick={()=>perform(refresh)}>{query?t('common.search','Search'):t('experiences.refresh','Load my proposals')}</button></div>
    {error&&<p role="alert" className="text-xs text-red-500">{error}</p>}
    {message&&<p role="status" className="text-xs">{message}</p>}
    {listing?.key===scopeKey&&!rows.length&&<p className="text-xs">{t('experiences.empty','No proposals found in this scope.')}</p>}
    {rows.map(entry=><article key={entry.experience_id} className="rounded border border-[var(--hub-line)] p-3 space-y-2">
      <h3 className="text-sm font-medium">{entry.title}</h3><p className="text-xs whitespace-pre-wrap break-words">{entry.summary}</p>
      <p className="text-xs text-[var(--hub-ink-3)]">{t(`experiences.status.${entry.status}`,entry.status)} · #{entry.revision} · {t(`experiences.confidence.${entry.assessment.confidence}`,entry.assessment.confidence)} · {entry.assessment.independentTasks} {t('experiences.tasks','reviewed tasks')}</p>
      <p className="text-xs break-words">{entry.task_type} · {(entry.scope.servers??[]).join(', ')||t('experiences.general','General server scope')} · {(entry.scope.tools??[]).join(', ')||t('experiences.allTools','General tool scope')}</p>
      <p className="text-xs text-[var(--hub-ink-3)]">{entry.reviewed_by} · {new Date(entry.reviewed_at).toLocaleString()}</p>
      {Object.keys(entry.tool_versions).length>0&&<p className="text-xs">{t('experiences.reportedVersions','Reported version constraints')}: {Object.entries(entry.tool_versions).map(([name,version])=>`${name}: ${version}`).join(', ')}</p>}
      {!entry.assessment.usable&&<p className="text-xs text-red-500">{t('experiences.stale','Evidence is unavailable or its approval changed. This entry is excluded from advice.')}</p>}
      <div className="flex flex-wrap gap-2">{entry.evidence_ids.map(id=><Link key={id} className="hub-mono text-xs break-all text-[var(--hub-accent)]" to={`/tool-results/${encodeURIComponent(id)}`}>{id}</Link>)}</div>
      <div className="flex gap-2">{['draft','approved','retired'].filter(status=>status!==entry.status).map(status=><button type="button" className="hub-btn" key={status} disabled={busy||(status==='approved'&&!entry.assessment.usable)} onClick={()=>perform(()=>changeStatus(entry,status))}>{t(`experiences.actions.${status}`,status)}</button>)}</div>
    </article>)}
  </div>;
}
export default function ExperienceMemoryPanel(props:{resultIds:string[]}){
  const {t}=useTranslation();const [open,setOpen]=useState(false);
  return <section className="hub-card p-3 space-y-3"><button type="button" className="hub-btn" aria-expanded={open} onClick={()=>setOpen(!open)}>{t('experiences.title','Experience Memory')}</button>{open&&<ExperienceManager {...props}/>}</section>;
}
