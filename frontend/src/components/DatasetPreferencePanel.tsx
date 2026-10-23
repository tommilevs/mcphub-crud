import {useEffect,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Link} from 'react-router-dom';
import {preferenceAvailability,listPreferences,createPreference,reviewPreference,type DatasetPreference} from '@/services/datasetPreferenceService';

function PreferenceReview({entry,keyId,busy,perform,refresh}:{entry:DatasetPreference;keyId:string;busy:boolean;
  perform:(action:()=>Promise<void>)=>Promise<void>;refresh:()=>Promise<void>}){
  const {t}=useTranslation();
  const [reason,setReason]=useState(entry.rationale),[approved,setApproved]=useState(false);
  const update=async(status:string,edit=false)=>{
    const response=await reviewPreference(entry.preference_id,{keyId:keyId||null,revision:entry.revision,status,
      ...(edit?{rationale:reason}:{}),...(status==='approved'?{comparabilityConfirmed:true,privacyApproved:true}:{})});
    if(!response.success)throw new Error(response.message||t('app.error'));
    setApproved(false);await refresh();
  };
  return <article className="space-y-2 rounded border border-[var(--hub-line)] p-3 text-xs">
    <p>{t(`experiences.status.${entry.status}`,entry.status)} · #{entry.revision} · {entry.reviewed_by}</p>
    <div className="flex flex-wrap gap-3"><Link className="text-[var(--hub-accent)] break-all" to={`/tool-results/${entry.chosen_id}`}>{t('datasets.chosen','Preferred')}: {entry.chosen_id}</Link>
      <Link className="text-[var(--hub-accent)] break-all" to={`/tool-results/${entry.rejected_id}`}>{t('datasets.rejected','Rejected')}: {entry.rejected_id}</Link></div>
    <label className="block">{t('datasets.preferenceReason','Comparative assessment (not exported)')}<textarea className="hub-input mt-1 w-full" rows={3} maxLength={4000} value={reason} disabled={busy||entry.status==='retired'} onChange={event=>{setReason(event.target.value);setApproved(false);}}/></label>
    <p className="hub-mono break-all">{t('datasets.evidenceDigest','Saved evidence digest')}: {entry.evidence_digest}</p>
    <label className="flex items-start gap-2"><input type="checkbox" disabled={busy||entry.status==='retired'||reason!==entry.rationale} checked={approved} onChange={event=>setApproved(event.target.checked)}/>{t('datasets.preferenceApproval','I compared this saved pair in the same derived context and approve its preference and privacy for export.')}</label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="hub-btn" disabled={busy||entry.status==='retired'||!reason.trim()} onClick={()=>perform(()=>update('draft',true))}>{t('datasets.preferenceRefresh','Save / refresh as draft')}</button>
      <button type="button" className="hub-btn" disabled={busy||entry.status!=='draft'||!approved||reason!==entry.rationale} onClick={()=>perform(()=>update('approved'))}>{t('skills.approve','Approve revision')}</button>
      <button type="button" className="hub-btn" disabled={busy||entry.status==='retired'} onClick={()=>perform(()=>update('retired'))}>{t('experiences.actions.retired','Retire')}</button>
    </div>
  </article>;
}

export default function DatasetPreferencePanel({resultIds,keyId,allowSelfReported,onChooseDpo}:{resultIds:string[];keyId:string;allowSelfReported:boolean;onChooseDpo:()=>void}){
  const {t}=useTranslation();
  const [open,setOpen]=useState(false),[enabled,setEnabled]=useState<boolean>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [chosen,setChosen]=useState(resultIds[0]??''),[reason,setReason]=useState(''),[comparable,setComparable]=useState(false);
  const [listing,setListing]=useState<{key:string;rows:DatasetPreference[]}>();
  const selectionKey=JSON.stringify([resultIds,keyId,allowSelfReported]);
  useEffect(()=>{setChosen(resultIds[0]??'');setReason('');setComparable(false);},[selectionKey]);
  const rejected=resultIds.find(id=>id!==chosen)??'';
  const refresh=async()=>{
    const response=await listPreferences(keyId);
    if(!response.success||!response.data)throw new Error(response.message||t('app.error'));
    setListing({key:keyId,rows:response.data});
  };
  const perform=async(action:()=>Promise<void>)=>{
    setBusy(true);setError('');try{await action();}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
  };
  return <section className="space-y-3 border-t border-[var(--hub-line)] pt-3">
    <button type="button" className="hub-btn" disabled={busy} aria-expanded={open} onClick={()=>{
      setOpen(!open);if(!open)void perform(async()=>{
        const response=await preferenceAvailability();
        if(!response.success)throw new Error(response.message||t('app.error'));
        setEnabled(response.data?.enabled??false);if(response.data?.enabled)await refresh();
      });
    }}>{t('datasets.preferences','Review preference pairs')}</button>
    {error&&<p role="alert" className="text-xs text-red-500">{error}</p>}
    {open&&enabled===false&&<p className="text-xs">{t('datasets.dpoDisabled','DPO is disabled.')}</p>}
    {open&&enabled&&<div className="space-y-3">
      <p className="text-xs text-[var(--hub-ink-3)]">{t('datasets.preferenceHelp','Select two results and inspect their reviews. The objective and available catalogue must match exactly; actions must differ. Preferred quality must be correct, rejected quality incorrect. Technical errors alone are not preference labels. Hidden client context is not reconstructed.')}</p>
      <label className="block text-xs">{t('datasets.chosen','Preferred')}<select className="hub-input mt-1 w-full" value={chosen} disabled={busy||resultIds.length!==2} onChange={event=>{setChosen(event.target.value);setComparable(false);}}>{resultIds.map(id=><option key={id} value={id}>{id}</option>)}</select></label>
      <p className="text-xs break-all">{t('datasets.rejected','Rejected')}: {rejected}</p>
      <label className="block text-xs">{t('datasets.preferenceReason','Comparative assessment (not exported)')}<textarea className="hub-input mt-1 w-full" rows={3} maxLength={4000} value={reason} disabled={busy} onChange={event=>{setReason(event.target.value);setComparable(false);}}/></label>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={comparable} disabled={busy||resultIds.length!==2} onChange={event=>setComparable(event.target.checked)}/>{t('datasets.comparableConfirmed','I compared these actions under the same reviewed objective and catalogue and explained why one is preferable.')}</label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="hub-btn" disabled={busy||resultIds.length!==2||!chosen||!rejected||!comparable||!reason.trim()} onClick={()=>perform(async()=>{
          const response=await createPreference({chosenId:chosen,rejectedId:rejected,rationale:reason,keyId:keyId||null,allowSelfReported,comparabilityConfirmed:true});
          if(!response.success)throw new Error(response.message||t('app.error'));
          setComparable(false);setReason('');await refresh();
        })}>{t('datasets.createPreference','Save preference draft')}</button>
        <button type="button" className="hub-btn" disabled={busy} onClick={()=>perform(refresh)}>{t('experiences.refresh','Load my proposals')}</button>
        <button type="button" className="hub-btn" disabled={busy} onClick={onChooseDpo}>{t('datasets.useDpo','Use DPO export format')}</button>
      </div>
      {(listing?.key===keyId?listing.rows:[]).map(entry=><PreferenceReview key={`${keyId}:${entry.preference_id}:${entry.revision}`} entry={entry} keyId={keyId} busy={busy} perform={perform} refresh={refresh}/>)}
    </div>}
  </section>;
}
