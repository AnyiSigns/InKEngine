/**
 * 设置「应用能力」节：模型档位 + 推理强度档 + 搜索 key。
 *
 * 推理档按 reasoning_profile 声明渲染：param=null 的模型档隐藏强度
 * 控制器并提示「该模型不支持推理强度调节」；推演档位三选
 * （关 / 轻探测 / 全量）；搜索 key 配置项 search_key/search_provider
 * （集成期由宿主接入真实密钥，此处收藏不落盘日志）。
 */

import { Field, TextInput, Select } from '@/shared/ui/Field';
import type { GearTier } from '@/shared/session/types';

export const TIER_KEYS: GearTier[] = ['router', 'main'];
export const TIER_LABELS: Record<GearTier, string> = {
  router: 'router',
  main: 'main',
};

export type SimulationTier = 'off' | 'light' | 'full';

export const SIMULATION_TIER_LABELS: Record<SimulationTier, string> = {
  off: '关',
  light: '轻探测',
  full: '全量',
};

export interface ReasoningProfileSpec {
  id: string;
  label: string;
  /** 推理强度参数；null = 该模型不支持强度调节 */
  param: 'low' | 'medium' | 'high' | null;
}

export const REASONING_PROFILES: ReasoningProfileSpec[] = [
  { id: 'deepseek-chat', label: 'DeepSeek Chat', param: 'high' },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', param: 'low' },
  { id: 'glm-lite', label: 'GLM Lite', param: null },
];

export const SEARCH_PROVIDERS = ['exa', 'parallel', 'bocha'] as const;

export interface CapabilityValue {
  gear: Record<GearTier, { modelId: string; fallback: boolean }>;
  reasoningProfileId: string;
  simulationTier: SimulationTier;
  searchKey: string;
  searchProvider: (typeof SEARCH_PROVIDERS)[number];
}

export const DEFAULT_CAPABILITY: CapabilityValue = {
  gear: { router: { modelId: '', fallback: true }, main: { modelId: 'deepseek-chat', fallback: false } },
  reasoningProfileId: 'deepseek-chat',
  simulationTier: 'light',
  searchKey: '',
  searchProvider: 'exa',
};

interface AppCapabilitySectionProps {
  value: CapabilityValue;
  patch: (next: Partial<CapabilityValue>) => void;
}

export function AppCapabilitySection({ value, patch }: AppCapabilitySectionProps) {
  const activeProfile = REASONING_PROFILES.find((profile) => profile.id === value.reasoningProfileId) ?? REASONING_PROFILES[0];
  const supportsTier = activeProfile.param !== null;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 text-[11px] font-medium tracking-wide ink-text-muted">模型挡位</div>
        <div className="space-y-2.5">
          {TIER_KEYS.map((tier) => (
            <div key={tier} className="ink-elevated flex items-center gap-3 px-3.5 py-2.5">
              <span className="w-24 shrink-0 text-[var(--ink-font-xs)] font-medium">{TIER_LABELS[tier]}</span>
              <TextInput
                value={value.gear[tier].modelId}
                placeholder="model_id"
                aria-label={`${tier} 模型`}
                className="flex-1"
                onChange={(e) => patch({ gear: { ...value.gear, [tier]: { ...value.gear[tier], modelId: e.target.value } } })}
              />
              <label className="flex shrink-0 items-center gap-1.5 pl-1 cursor-pointer" title="留空回落 main">
                <input
                  type="checkbox"
                  className="ink-check"
                  checked={value.gear[tier].fallback}
                  onChange={(e) => patch({ gear: { ...value.gear, [tier]: { ...value.gear[tier], fallback: e.target.checked } } })}
                />
                <span className="text-[10px] ink-text-muted">fallback</span>
              </label>
            </div>
          ))}
        </div>
        <p className="pt-1 text-[10px] leading-relaxed ink-text-faint">双挡位分工：router / main；某挡位留空时回落 main。</p>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-medium tracking-wide ink-text-muted">推理强度档</div>
        <Field label="模型档" hint="按 reasoning_profile 声明渲染；param=null 的档位不支持强度调节。">
          <Select
            value={activeProfile.id}
            aria-label="推理模型档"
            onChange={(e) => patch({ reasoningProfileId: e.target.value })}
          >
            {REASONING_PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}（{profile.param === null ? '不支持调节' : profile.param}）
              </option>
            ))}
          </Select>
        </Field>
        {supportsTier ? (
          <div className="mt-2 flex items-center gap-3">
            <span className="w-32 shrink-0 text-[11px] ink-text-muted">推演档位</span>
            <div className="ink-seg">
              {(Object.keys(SIMULATION_TIER_LABELS) as SimulationTier[]).map((tier) => (
                <button
                  key={tier}
                  data-ui={`sim_tier_${tier}`}
                  data-active={value.simulationTier === tier}
                  onClick={() => patch({ simulationTier: tier })}
                  className="ink-seg-item"
                >
                  {SIMULATION_TIER_LABELS[tier]}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-2 ink-status-bubble px-3 py-2 text-[10px] ink-text-muted" data-ui="reasoning_tier_unavailable">
            该模型不支持推理强度调节（param=null）：推演档位控制器已隐藏
          </div>
        )}
      </div>

      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">搜索 key 配置</div>
        <Field label="search_key" hint="仅本地持有；集成期走宿主密钥通道，不写入事件流。">
          <TextInput
            type="password"
            autoComplete="off"
            value={value.searchKey}
            onChange={(e) => patch({ searchKey: e.target.value })}
            aria-label="search_key"
            placeholder="sk-…"
          />
        </Field>
        <Field label="search_provider">
          <Select
            value={value.searchProvider}
            aria-label="search_provider"
            onChange={(e) => patch({ searchProvider: e.target.value as CapabilityValue['searchProvider'] })}
          >
            {SEARCH_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>{provider}</option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  );
}
