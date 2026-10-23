import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Link} from 'react-router-dom';
import {readExperience,type ExperienceEntry} from '@/services/experienceService';
export default function ExperienceReference({id,keyId}:{id:string;keyId?:string}){
  const {t}=useTranslation();const [entry,setEntry]=useState<ExperienceEntry>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  return <div className="border-t border-[var(--hub-line)] pt-2 space-y-2">
    <button type="button" className="hub-btn" disabled={busy} onClick={async()=>{
      setBusy(true);setError('');setEntry(undefined);
      try{const response=await readExperience(id,keyId??'');if(!response.success||!response.data)throw new Error(response.message||t('app.error'));setEntry(response.data);}
      catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
    }}>{t('experiences.viewCurrent','Load current reviewed strategy')}</button>
    {error&&<p role="alert" className="text-xs">{error}</p>}
    {entry&&<><h3 className="text-sm font-medium">{entry.title}</h3><p className="text-xs whitespace-pre-wrap break-words">{entry.summary}</p>
      <p className="text-xs">#{entry.revision} · {t(`experiences.confidence.${entry.assessment.confidence}`,entry.assessment.confidence)}</p>
      <div className="flex flex-wrap gap-2">{entry.evidence_ids.map(result=><Link key={result} className="hub-mono text-xs break-all text-[var(--hub-accent)]" to={`/tool-results/${encodeURIComponent(result)}`}>{result}</Link>)}</div></>}
  </div>;
}
