import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Link} from 'react-router-dom';
import {listDatasetExports,type DatasetExportRecord} from '@/services/datasetService';
export default function DatasetExportHistory({keyId}:{keyId:string}){
  const {t}=useTranslation();
  const [rows,setRows]=useState<DatasetExportRecord[]>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <div className="space-y-3 border-t border-[var(--hub-line)] pt-3">
    <button type="button" className="hub-btn" disabled={busy} onClick={async()=>{
      setBusy(true);setError('');try{
        const response=await listDatasetExports(keyId);
        if(!response.success||!response.data)throw new Error(response.message||t('app.error'));
        setRows(response.data);
      }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
    }}>{t('datasets.exportHistory','Load export history')}</button>
    {error&&<p role="alert" className="text-xs text-red-500">{error}</p>}
    {rows&&<p className="text-xs text-[var(--hub-ink-3)]">{t('datasets.historyHelp','Latest 50 export receipts in this key scope. Receipts contain references and hashes, not saved training payloads. Consent is checked again for every new download.')}</p>}
    {rows?.length===0&&<p className="text-xs">{t('datasets.noExports','No exports recorded.')}</p>}
    {rows?.map(row=><article key={row.export_id} className="space-y-1 rounded border border-[var(--hub-line)] p-2 text-xs">
      <p>{new Date(row.created_at).toLocaleString()} · {row.split} · {row.exported_ids.length} {t('datasets.examples','examples')} · {row.byte_length} B</p>
      <p className="hub-mono break-all">{row.export_id}</p>
      <p className="hub-mono break-all">SHA-256 · {row.file_sha256}</p>
      <details><summary>{t('datasets.exportSources','Exported source results')}</summary><div className="flex flex-wrap gap-2 pt-2">{row.exported_ids.map(id=><Link className="hub-mono break-all text-[var(--hub-accent)]" key={id} to={`/tool-results/${encodeURIComponent(id)}`}>{id}</Link>)}</div></details>
    </article>)}
  </div>;
}
