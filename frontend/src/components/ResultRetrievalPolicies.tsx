import {useEffect,useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {ResultRetrievalConfig,ResultRetrievalRule} from '@/types/resultRetrieval';

export default function ResultRetrievalPolicies({value,onChange,disabled}:{value:ResultRetrievalConfig;onChange:(value:ResultRetrievalConfig)=>void;disabled:boolean}){
 const {t}=useTranslation();
 const [draft,setDraft]=useState<ResultRetrievalConfig>(value);
 const [target,setTarget]=useState('');
 const [mode,setMode]=useState<'passthrough'|'fragments'>('passthrough');
 const [threshold,setThreshold]=useState('');
 const [budget,setBudget]=useState('');
 useEffect(()=>setDraft(value),[value]);
 const validNumber=(text:string,min:number,max:number)=>text===''||(Number.isInteger(Number(text))&&Number(text)>=min&&Number(text)<=max);
 const ruleValid=target.trim().length>0&&target.trim().length<=512&&validNumber(threshold,512,1000000)&&validNumber(budget,512,4096);
 const defaultsValid=Number.isInteger(draft.minTokens??8000)&&(draft.minTokens??8000)>=512&&(draft.minTokens??8000)<=1000000&&Number.isInteger(draft.maxOutputTokens??3000)&&(draft.maxOutputTokens??3000)>=512&&(draft.maxOutputTokens??3000)<=4096;
 const addRule=()=>{
  if(!ruleValid)return;
  const rule:ResultRetrievalRule={mode,...(threshold!==''?{minTokens:Number(threshold)}:{}),...(budget!==''?{maxOutputTokens:Number(budget)}:{})};
  setDraft({...draft,policies:{...draft.policies,[target.trim()]:rule}});setTarget('');setThreshold('');setBudget('');
 };
 return <fieldset disabled={disabled} className="space-y-3 border-t border-[var(--hub-line)] pt-3">
  <legend className="text-sm font-medium">{t('retrieval.title','Original result fragments')}</legend>
  <p className="text-xs text-[var(--hub-ink-3)]">{t('retrieval.help','RAW is retained first. Calls must explicitly request retrieval. Full response rules override that request.')}</p>
  <div className="flex flex-wrap gap-3">
   <label className="text-xs">{t('retrieval.defaultMode','Default response')}
    <select className="hub-input mt-1 block" value={draft.mode??'fragments'} onChange={event=>setDraft({...draft,mode:event.target.value as ResultRetrievalRule['mode']})}>
     <option value="fragments">{t('retrieval.fragments','Relevant original fragments')}</option><option value="passthrough">{t('retrieval.full','Full response')}</option>
    </select>
   </label>
   <label className="text-xs">{t('retrieval.threshold','Minimum tokens')}
    <input className="hub-input mt-1 block w-36" type="number" min={512} max={1000000} value={draft.minTokens??8000} onChange={event=>setDraft({...draft,minTokens:Number(event.target.value)})}/>
   </label>
   <label className="text-xs">{t('retrieval.budget','Fragment token limit')}
    <input className="hub-input mt-1 block w-36" type="number" min={512} max={4096} value={draft.maxOutputTokens??3000} onChange={event=>setDraft({...draft,maxOutputTokens:Number(event.target.value)})}/>
   </label>
  </div>
  <p className="text-xs text-[var(--hub-ink-3)]">{t('retrieval.targets','Overrides: server/*, tool, or server/tool. Blank numbers inherit defaults.')}</p>
  {Object.entries(draft.policies??{}).map(([name,rule])=><div key={name} className="flex flex-wrap items-center gap-2 text-xs">
   <span className="min-w-0 flex-1 break-all">{name}: {(rule.mode??draft.mode)==='passthrough'?t('retrieval.full','Full response'):t('retrieval.fragments','Relevant original fragments')}{rule.minTokens!==undefined?` · ${rule.minTokens}+`:''}{rule.maxOutputTokens!==undefined?` · ≤${rule.maxOutputTokens}`:''}</span>
   <button type="button" className="hub-btn" aria-label={`${t('common.remove','Remove')} ${name}`} onClick={()=>setDraft({...draft,policies:Object.fromEntries(Object.entries(draft.policies??{}).filter(([key])=>key!==name))})}>{t('common.remove','Remove')}</button>
  </div>)}
  <div className="flex flex-wrap gap-2">
   <input className="hub-input min-w-0 flex-1" aria-label={t('retrieval.target','Server or tool override')} placeholder="server/tool" value={target} onChange={event=>setTarget(event.target.value)}/>
   <select className="hub-input" aria-label={t('retrieval.mode','Override response')} value={mode} onChange={event=>setMode(event.target.value as typeof mode)}>
    <option value="passthrough">{t('retrieval.full','Full response')}</option><option value="fragments">{t('retrieval.fragments','Relevant original fragments')}</option>
   </select>
   <input className="hub-input w-32" type="number" min={512} max={1000000} aria-label={t('retrieval.overrideThreshold','Override minimum tokens')} placeholder="8000" value={threshold} onChange={event=>setThreshold(event.target.value)}/>
   <input className="hub-input w-32" type="number" min={512} max={4096} aria-label={t('retrieval.overrideBudget','Override token limit')} placeholder="3000" value={budget} onChange={event=>setBudget(event.target.value)}/>
   <button type="button" className="hub-btn" disabled={!ruleValid||(Object.keys(draft.policies??{}).length>=1000&&!Object.prototype.hasOwnProperty.call(draft.policies??{},target.trim()))} onClick={addRule}>{t('retrieval.add','Add or replace rule')}</button>
  </div>
  <button type="button" className="hub-btn primary" disabled={!defaultsValid} onClick={()=>onChange(draft)}>{t('retrieval.save','Save result policies')}</button>
 </fieldset>;
}
