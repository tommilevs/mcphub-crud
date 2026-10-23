import {useEffect,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {getDatasetAvailability,previewDataset,downloadDataset,type DatasetManifest} from '@/services/datasetService';
import DatasetExportHistory from './DatasetExportHistory';
import DatasetPreferencePanel from './DatasetPreferencePanel';

export default function DatasetBuilderPanel({resultIds}:{resultIds:string[]}){
  const {t}=useTranslation();
  const [enabled,setEnabled]=useState<boolean>();
  const [keyId,setKeyId]=useState('');
  const [allowSelfReported,setAllowSelfReported]=useState(false);
  const [seed,setSeed]=useState('mcphub-v1');
  const [split,setSplit]=useState('train');
  const [format,setFormat]=useState('tool-selection-sft');
  const [preview,setPreview]=useState<{key:string;data:DatasetManifest}>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const selection={resultIds:[...resultIds].sort(),keyId:keyId.trim()||null,allowSelfReported,seed,format};
  const selectionKey=JSON.stringify(selection);
  const manifest=preview?.key===selectionKey?preview.data:undefined;
  useEffect(()=>{
    let active=true;
    getDatasetAvailability().then(response=>{if(active){if(response.success)setEnabled(response.data?.enabled??false);else setError(response.message||t('app.error'));}})
      .catch(reason=>{if(active)setError(String(reason));});
    return()=>{active=false;};
  },[]);
  const run=async(download:boolean)=>{
    setBusy(true);setError('');
    try{
      if(download){
        const blob=await downloadDataset(selection,split);
        if(!blob.size){setPreview(undefined);throw new Error(t('datasets.empty','No eligible examples remain. Refresh the preview.'));}
        const url=URL.createObjectURL(blob),link=document.createElement('a');
        link.href=url;link.download=`mcphub-${format==='recorded-tool-trajectory'?'trajectory':format==='tool-preference-dpo'?'dpo':'sft'}-${split}.jsonl`;document.body.appendChild(link);link.click();link.remove();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      }else{
        const response=await previewDataset(selection);
        if(!response.success||!response.data)throw new Error(response.message||t('app.error'));
        setPreview({key:selectionKey,data:response.data});
      }
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setBusy(false);}
  };
  return <section className="hub-card p-3 space-y-3">
    <h2 className="text-sm font-medium">{t('datasets.title','Dataset Builder')} · {resultIds.length}</h2>
    {error&&<p role="alert" className="text-xs text-red-500">{error}</p>}
    {enabled===undefined?(!error&&<p className="text-xs">{t('app.loading')}</p>):!enabled?<p className="text-xs">{t('datasets.disabled','Dataset Builder is disabled.')}</p>:<>
      <p className="text-xs text-[var(--hub-ink-3)]">{t('datasets.help','Export reviewed positive tool-selection examples from your own calls. Each download rechecks consent and reviews; RAW contents are excluded. Select up to 100 results.')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs">{t('datasets.keyScope','API key ID (blank for calls without a key; never enter a token)')}<input className="hub-input mt-1 w-full" value={keyId} disabled={busy} onChange={event=>setKeyId(event.target.value)}/></label>
        <label className="text-xs">{t('datasets.seed','Split seed')}<input className="hub-input mt-1 w-full" value={seed} maxLength={128} disabled={busy} onChange={event=>setSeed(event.target.value)}/></label>
      </div>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={allowSelfReported} disabled={busy} onChange={event=>setAllowSelfReported(event.target.checked)}/>{t('datasets.allowSelf','Include self-reported models explicitly; these examples remain unverified.')}</label>
      <label className="block text-xs">{t('datasets.format','Export format')}<select className="hub-input mt-1 block" value={format} disabled={busy} onChange={event=>setFormat(event.target.value)}>
        <option value="tool-selection-sft">{t('datasets.sftFormat','Positive tool-selection SFT')}</option>
        <option value="recorded-tool-trajectory">{t('datasets.trajectoryFormat','Recorded tool trajectories by model segment')}</option>
        <option value="tool-preference-dpo">{t('datasets.dpoFormat','Reviewed tool preference pairs (DPO)')}</option>
      </select></label>
      {format==='recorded-tool-trajectory'&&<p className="text-xs text-[var(--hub-ink-3)]">{t('datasets.trajectoryHelp','Select every retained call in each model segment. Reviewed errors stay labeled as errors. Results are references; hidden client conversation and final answers are not reconstructed.')}</p>}
      <p className="text-xs text-[var(--hub-ink-3)]">{t('datasets.registryHelp','Earlier exports keep related tasks, traces and duplicate examples in the same split, even if the seed changes. Conflicting past assignments block export. Previews are provisional until download.')}</p>
      <button type="button" className="hub-btn" disabled={busy||resultIds.length>100||!seed} onClick={()=>run(false)}>{t('datasets.preview','Preview eligibility')}</button>
      {manifest&&<div className="space-y-3">
        <p className="text-xs">{t('datasets.counts','Eligible: {{eligible}} · Duplicates: {{duplicates}}',{eligible:manifest.exported,duplicates:manifest.duplicates})}</p>
        {Object.entries(manifest.excluded).length>0&&<dl className="text-xs space-y-1">{Object.entries(manifest.excluded).map(([reason,count])=><div key={reason} className="flex justify-between gap-3"><dt>{t(`datasets.reasons.${reason}`,reason.replace(/_/g,' '))}</dt><dd className="hub-mono">{count}</dd></div>)}</dl>}
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs">{t('datasets.split','Download split')}<select className="hub-input mt-1 block" value={split} disabled={busy} onChange={event=>setSplit(event.target.value)}>
            {['train','validation','test'].map(value=><option key={value} value={value}>{t(`datasets.splits.${value}`,value)} · {manifest.splits[value]??0}</option>)}
          </select></label>
          <button type="button" className="hub-btn" disabled={busy||!(manifest.splits[split]>0)} onClick={()=>run(true)}>{t('datasets.download','Download JSONL')}</button>
        </div>
        <p className="hub-mono text-xs break-all">SHA-256 · {manifest.contentSha256}</p>
      </div>}
      <DatasetExportHistory key={keyId.trim()} keyId={keyId.trim()}/>
      <DatasetPreferencePanel resultIds={selection.resultIds} keyId={keyId.trim()} allowSelfReported={allowSelfReported} onChooseDpo={()=>setFormat('tool-preference-dpo')}/>
    </>}
  </section>;
}
