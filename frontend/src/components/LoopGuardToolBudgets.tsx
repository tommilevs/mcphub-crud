import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export default function LoopGuardToolBudgets({ value, onChange, disabled }: {
  value: Record<string, number>; onChange: (value: Record<string, number>) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const [tool, setTool] = useState('');
  const [budget, setBudget] = useState(3);
  const valid = tool.length <= 1024 && /^[^\s/]+\/\S+$/.test(tool) &&
    !/[\u0000-\u001f]/.test(tool) && Number.isInteger(budget) && budget >= 3 && budget <= 100 &&
    (Object.prototype.hasOwnProperty.call(value, tool) || Object.keys(value).length < 100);
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="text-xs">{t('attribution.loopToolBudgets', 'Per-tool repetition thresholds')}</legend>
    <p className="text-xs text-[var(--hub-ink-3)]">{t('attribution.loopToolBudgetsHelp', 'Exact server/tool overrides. A two-tool cycle uses the larger threshold. Exclusions still apply.')}</p>
    {Object.entries(value).map(([name, repetitions]) => <div key={name} className="flex items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 break-all">{name}: {repetitions}</span>
      <button type="button" className="hub-btn" aria-label={`${t('common.remove', 'Remove')} ${name}`} onClick={() => {
        onChange(Object.fromEntries(Object.entries(value).filter(([key]) => key !== name)));
      }}>{t('common.remove', 'Remove')}</button>
    </div>)}
    <div className="flex flex-wrap gap-2">
      <input className="hub-input min-w-0 flex-1" aria-label={t('attribution.loopToolName', 'Server/tool')} placeholder="server/tool"
        value={tool} onChange={(event) => setTool(event.target.value)} />
      <input className="hub-input w-24" type="number" min={3} max={100} step={1}
        aria-label={t('attribution.loopRepetitions', 'Repetitions before advice (3–100)')}
        value={budget} onChange={(event) => setBudget(Number(event.target.value))} />
      <button type="button" className="hub-btn" disabled={!valid} onClick={() => {
        onChange({ ...value, [tool]: budget }); setTool('');
      }}>{t('common.add', 'Add')}</button>
    </div>
  </fieldset>;
}
