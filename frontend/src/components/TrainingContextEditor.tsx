import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getTrainingContext, saveTrainingContext, type TrainingContextData } from '@/services/toolResultHistoryService';

function ContextForm({resultId,onSaved}:{resultId:string;onSaved:()=>Promise<void>}) {
  const {t}=useTranslation();
  const [data,setData]=useState<TrainingContextData>();
  const [source,setSource]=useState('');
  const [text,setText]=useState('[]');
  const [approved,setApproved]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const load=async()=>{
    const response=await getTrainingContext(resultId);
    if(!response.success||!response.data)throw new Error(response.message||t('app.error'));
    return response.data;
  };
  const apply=(next:TrainingContextData)=>{
    setData(next);setSource(next.current?.discoveryCallId??next.sources[0]?.callId??'');
    setText(JSON.stringify(next.current?.tools??[],null,2));setApproved(false);
  };
  useEffect(()=>{
    let active=true;
    load().then(next=>{if(active)apply(next);}).catch(reason=>{if(active)setError(String(reason));});
    return()=>{active=false;};
  },[resultId]); // Locale changes must not discard an unsaved review.
  const save=async(revoke:boolean)=>{
    if(!data)return;
    setSaving(true);setError('');
    try{
      const value=revoke?{revision:data.current?.revision??0,privacyApproved:false}:
        {revision:data.current?.revision??0,discoveryCallId:source,tools:JSON.parse(text),privacyApproved:true};
      const response=await saveTrainingContext(resultId,value);
      if(!response.success)throw new Error(response.message||t('app.error'));
      apply(await load());await onSaved();
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setSaving(false);}
  };
  if(!data)return <p role={error?'alert':undefined} className="text-xs">{error||t('app.loading')}</p>;
  const sourceAvailable=data.sources.some(item=>item.callId===source);
  return <div className="space-y-3">
    <p className="text-xs text-[var(--hub-ink-3)]">{t('attribution.contextHelp','Paste the exact original discovery catalogue. Schema and description fingerprints are checked against the selected source. Approval covers this context only; task consent and call privacy review remain separate.')}</p>
    <p className="text-xs break-words">{data.objective||t('attribution.contextMissingObjective','No original objective is saved; this result cannot be approved.')}</p>
    <label className="block text-xs">{t('attribution.contextSource','Original discovery')}
      <select className="hub-input mt-1 block w-full" disabled={saving} value={source} onChange={event=>{setSource(event.target.value);setApproved(false);}}>
        {!sourceAvailable&&<option value={source}>{t('attribution.contextUnavailable','Source unavailable')}</option>}
        {data.sources.map(item=><option key={item.callId} value={item.callId}>{new Date(item.occurredAt).toLocaleString()} · {item.evidence.candidates.length} tools · {item.callId}</option>)}
      </select>
    </label>
    <label className="block text-xs">{t('attribution.contextCatalogue','Original tool catalogue (JSON array)')}
      <textarea className="hub-input mt-1 block w-full hub-mono" rows={8} value={text} disabled={saving}
        onChange={event=>{setText(event.target.value);setApproved(false);}} />
    </label>
    <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={approved} disabled={saving}
      onChange={event=>setApproved(event.target.checked)} />{t('attribution.contextApprove','I reviewed this objective and catalogue and approve this context for training.')}</label>
    {data.current&&<p className="text-xs">#{data.current.revision} · {data.current.reviewedBy} · {data.current.privacyApproved?t('attribution.privacyValues.approved'):t('attribution.privacyValues.rejected')}</p>}
    {error&&<p role="alert" className="text-xs text-red-500">{error}</p>}
    <div className="flex gap-2">
      <button type="button" className="hub-btn" disabled={saving||!approved||!sourceAvailable||!data.objective||!data.invokedToolName} onClick={()=>save(false)}>{t('common.save')}</button>
      {data.current?.privacyApproved&&<button type="button" className="hub-btn" disabled={saving} onClick={()=>save(true)}>{t('attribution.contextRevoke','Revoke context approval')}</button>}
    </div>
  </div>;
}

export default function TrainingContextEditor(props:{resultId:string;onSaved:()=>Promise<void>}) {
  const {t}=useTranslation();
  const [open,setOpen]=useState(false);
  return <section className="hub-card p-3 space-y-3">
    <button type="button" className="hub-btn" aria-expanded={open} onClick={()=>setOpen(!open)}>{t('attribution.contextTitle','Training task and discovery context')}</button>
    {open&&<ContextForm {...props}/>}
  </section>;
}
