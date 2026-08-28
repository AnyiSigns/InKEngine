/**
 * 设置「应用能力」节：模型挡位（双挡）+ 推理强度档 per-挡 + 推演档位 + 搜索 key。
 *
 * 推理档按 reasoning_profile 声明渲染；param=null 的档位隐藏强度
 * 控制器并提示「该模型不支持推理强度调节」；推演档位三选
 * （关 / 轻探测 / 全量）；搜索 key 配置项（env INK_SEARCH_KEY 显式优先、
 * 设置档兜底）。
 */

import { useState } from 'react';

import { Button } from '@/shared/ui/Button';
import { Field, Select, TextInput } from '@/shared/ui/Field';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';

export type GearTier = 'router' | 'main' | 'audit';

export interface CapabilitySectionValue {
  mainModelId: string;
  routerModelId: string;
  auditModelId: string;
  mainTier: string;
  routerTier: string;
  auditTier: string;
  reasoningProfileId: string;
  simulationTier: 'off' | 'light' | 'full';
  searchKey: string;
  searchProvider: 'exa' | 'parallel' | 'bocha';
}

const DEFAULT_VALUE: CapabilitySectionValue = {
  mainModelId: '',
  routerModelId: '',
  auditModelId: '',
  mainTier: 'main',
  routerTier: 'router',
  auditTier: 'audit',
  reasoningProfileId: '',
  simulationTier: 'light',
  searchKey: '',
  searchProvider: 'exa',
};

export function CapabilitySection(): JSX.Element {
  const tauri = createTauriInvoker();
  const [value, setValue] = useState<CapabilitySectionValue>(DEFAULT_VALUE);
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const patch = (next: Partial<CapabilitySectionValue>): void => {
    setValue((prev) => ({ ...prev, ...next }));
  };

  const handleSave = async (): Promise<void> => {
    setSavePhase('saving');
    try {
      if (tauri) {
        await tauri.invoke('capability_put', { record: value });
      }
      setSavePhase('saved');
      setTimeout(() => setSavePhase('idle'), 1200);
    } catch {
      setSavePhase('error');
      setTimeout(() => setSavePhase('idle'), 2000);
    }
  };

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">模型挡位</div>
        {(['main', 'router', 'audit'] as GearTier[]).map((tier) => (
          <div key={tier} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-[11px] ink-text-muted">
              {tier === 'main' ? '主模型' : tier === 'router' ? '制片人' : '审计'}
            </span>
            <TextInput
              value={tier === 'main' ? value.mainModelId : tier === 'router' ? value.routerModelId : value.auditModelId}
              onChange={(e) => {
                if (tier === 'main') patch({ mainModelId: e.target.value });
                else if (tier === 'router') patch({ routerModelId: e.target.value });
                else patch({ auditModelId: e.target.value });
              }}
              placeholder="model_id"
              className="flex-1"
              aria-label={`${tier} 模型`}
            />
            <span className={[
              'ink-chip text-[9px]',
              tier === 'audit' ? 'ink-text-accent' : 'ink-text-faint',
            ].join(' ')}>
              {tier === 'audit' ? '审计' : tier === 'main' ? '主模型' : '制片人'}
            </span>
          </div>
        ))}
        <p className="text-[10px] leading-relaxed ink-text-faint">
          双挡位分工：制片人决策 / 主模型 / 审计；某挡位留空时回落主模型。
        </p>
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">推理强度档</div>
        <Field label="推理档" hint="per-挡位全局默认；输入行未选过时按此。">
          <Select
            value={value.reasoningProfileId}
            onChange={(e) => patch({ reasoningProfileId: e.target.value })}
            aria-label="推理档"
          >
            <option value="">未配置（使用模型默认）</option>
            <option value="deepseek-chat">DeepSeek Chat（high）</option>
            <option value="deepseek-reasoner">DeepSeek Reasoner（low）</option>
            <option value="glm-lite">GLM Lite（不支持调节）</option>
          </Select>
        </Field>
        <div className="flex items-center gap-3">
          <span className="w-32 shrink-0 text-[11px] ink-text-muted">推演档位</span>
          <div className="ink-seg">
            {(['off', 'light', 'full'] as const).map((tier) => (
              <button
                key={tier}
                data-ui={`sim_tier_${tier}`}
                data-active={value.simulationTier === tier}
                onClick={() => patch({ simulationTier: tier })}
                className="ink-seg-item"
              >
                {tier === 'off' ? '关' : tier === 'light' ? '轻探测' : '全量'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">搜索 key 配置</div>
        <Field label="search_key" hint="env INK_SEARCH_KEY 显式优先、设置档兜底；仅本地持有。">
          <TextInput
            value={value.searchKey}
            onChange={(e) => patch({ searchKey: e.target.value })}
            aria-label="search_key"
            placeholder="sk-..."
          />
        </Field>
        <Field label="search_provider">
          <Select
            value={value.searchProvider}
            onChange={(e) => patch({ searchProvider: e.target.value as CapabilitySectionValue['searchProvider'] })}
            aria-label="search_provider"
          >
            <option value="exa">exa</option>
            <option value="parallel">parallel</option>
            <option value="bocha">bocha</option>
          </Select>
        </Field>
      </div>

      <div className="flex items-center justify-end gap-2">
        <span className={[
          'text-[10px]',
          savePhase === 'saving' ? 'ink-text-muted' : '',
          savePhase === 'saved' ? 'ink-feedback-ok' : '',
          savePhase === 'error' ? 'ink-feedback-fail' : '',
        ].join(' ')}>
          {savePhase === 'saving' && '保存中…'}
          {savePhase === 'saved' && '已保存'}
          {savePhase === 'error' && '保存失败'}
        </span>
        <Button size="sm" variant="primary" onClick={handleSave} data-ui="capability_save">
          保存
        </Button>
      </div>
    </div>
  );
}
