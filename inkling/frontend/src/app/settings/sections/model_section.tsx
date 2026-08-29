/**
 * 设置「模型」节：厂商/端点/双挡模型/推理档/压缩红线/audit 徽标。
 *
 * 档位悬浮窗承载完整模型配置：
 * - 预设厂商（openai/deepseek/anthropic 等 8 家已适配）→ 自动带 base_url，
 *   只需填 model_id（+ 可选 api_key），展示厂商名与端点只读；
 * - 自定义提供商 → 需填 Provider ID（适配器标识）+ Provider API（base_url）
 *   + api_key + model_id，可手动指定端点。
 * key 掩码输入（三处剥离：仅保存不探测用壳命令 model_key_put；禁止入
 * engine.records/事件流/日志；错误不回显明文）；压缩红线联动展示。
 */

import { useEffect, useMemo, useState } from 'react';

import { AlertTriangle, RefreshCw } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Field, Select, TextInput } from '@/shared/ui/Field';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';
import { FloaterWindow } from '@/components/floaters/floater_window';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';

export type GearTier = 'main' | 'router' | 'audit';

export interface ModelArchiveEntry {
  id: string;
  name?: string;
  tier: GearTier;
  context_window?: number;
  multimodal?: boolean;
}

export interface ModelSectionValue {
  /** 预设厂商 id 或 '__custom__'。 */
  vendor: string;
  /** 自定义提供商标识（vendor='__custom__' 时填写）。 */
  providerId: string;
  /** 请求端点（预设自动带；可改专属端点）。 */
  baseUrl: string;
  apiKey: string;
  mainModelId: string;
  routerModelId: string;
  auditModelId: string;
  contextWindow: number;
  /** 压缩红线百分比（1~100，默认 80）。 */
  compressionPercent: number;
}

const VENDORS = [
  { id: 'openai', label: 'OpenAI', adapter: 'openai_compat', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', adapter: 'openai_compat', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'zhipu', label: '智谱 GLM', adapter: 'openai_compat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'moonshot', label: 'Moonshot', adapter: 'openai_compat', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'ollama', label: 'Ollama（本地）', adapter: 'openai_compat', baseUrl: 'http://localhost:11434/v1' },
  { id: 'dashscope', label: 'DashScope（通义千问）', adapter: 'openai_compat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'anthropic', label: 'Anthropic', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: 'Google Gemini', adapter: 'openai_compat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
] as const;

/** 预设厂商适配器（vendors 之外经 Provider API 自定义）。 */
function adapterOf(vendor: string): string {
  const v = VENDORS.find((x) => x.id === vendor);
  return v?.adapter ?? 'openai_compat';
}

const DEFAULT_CONTEXT = 128 * 1024;

const TIER_META: Array<{ tier: GearTier; label: string; hint: string }> = [
  { tier: 'main', label: 'main', hint: '正文生成与工具执行；必填。' },
  { tier: 'router', label: 'router', hint: '任务拆解与路径决策；留空回落 main。' },
  { tier: 'audit', label: 'audit', hint: '审批点复核与裁决；留空回落 main。' },
];

/**
 * 三档模型配置：档位各成一张卡（显示已配置 model_id / 回落状态），
 * 点击卡片弹悬浮窗配置该档——悬浮窗内为完整模型配置：
 * - 预设厂商（openai/deepseek/anthropic…）→ 自动带端点只读展示，填 model_id；
 * - 自定义提供商 → Provider ID + Provider API（base_url）+ api_key + model_id；
 * - 上下文窗口与压缩红线。
 * 悬浮窗默认视口居中（FloaterWindow 无 initialRect）。
 */
interface ProbeModel {
  id: string;
  context_window?: number;
}

function TierModelBlock({
  value,
  onCommit,
  savePhase,
}: {
  value: ModelSectionValue;
  onCommit: (patch: Partial<ModelSectionValue>) => void;
  savePhase: FeedbackPhase;
}): JSX.Element {
  const [editing, setEditing] = useState<GearTier | null>(null);
  const [draftVendor, setDraftVendor] = useState(value.vendor);
  const [draftProviderId, setDraftProviderId] = useState(value.providerId);
  const [draftBaseUrl, setDraftBaseUrl] = useState(value.baseUrl);
  const [draftApiKey, setDraftApiKey] = useState('');
  const [draftModelId, setDraftModelId] = useState('');
  const [draftContext, setDraftContext] = useState(value.contextWindow);
  const [draftPercent, setDraftPercent] = useState(value.compressionPercent || 80);
  const [probePhase, setProbePhase] = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');
  const [probeNote, setProbeNote] = useState('');
  const [probeList, setProbeList] = useState<ProbeModel[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  const valueOf = (tier: GearTier): string =>
    tier === 'main' ? value.mainModelId : tier === 'router' ? value.routerModelId : value.auditModelId;
  const configured = (tier: GearTier): boolean => valueOf(tier).trim().length > 0;

  const openEditor = (tier: GearTier): void => {
    setDraftVendor(value.vendor);
    setDraftProviderId(value.providerId);
    setDraftBaseUrl(value.baseUrl);
    setDraftApiKey('');
    setDraftModelId(valueOf(tier));
    setDraftContext(value.contextWindow);
    setDraftPercent(value.compressionPercent || 80);
    setProbePhase('idle');
    setProbeNote('');
    setProbeList([]);
    setShowPicker(false);
    setEditing(tier);
  };

  /** 探测端点模型列表 → 弹悬浮窗供选择（失败结构化降级）。 */
  const probeModels = async (): Promise<void> => {
    setProbePhase('loading');
    setProbeNote('');
    try {
      const endpoint = draftVendor === 'anthropic' ? `${draftBaseUrl}/v1/models` : `${draftBaseUrl}/models`;
      const res = await fetch(endpoint, {
        headers: draftApiKey ? { Authorization: `Bearer ${draftApiKey}` } : undefined,
      });
      if (!res.ok) throw new Error(`探测失败：${res.status} ${res.statusText}`);
      const data = (await res.json()) as { data?: ProbeModel[] };
      const models = data.data ?? [];
      if (models.length > 0) {
        setProbeList(models);
        setShowPicker(true);
        setProbeNote(`探测到 ${models.length} 个模型，请选择回填`);
      } else {
        setProbeNote('探测成功但无模型列表');
      }
      setProbePhase('success');
    } catch {
      setProbePhase('fail');
      setProbeNote('探测失败：检查端点与密钥');
    }
  };

  /** 选中探测列表中的模型 → 回填 model_id（及上下文窗口）。 */
  const pickModel = (m: ProbeModel): void => {
    setDraftModelId(m.id);
    if (m.context_window) setDraftContext(m.context_window);
    setShowPicker(false);
  };

  const commit = (): void => {
    if (!editing) return;
    onCommit({
      vendor: draftVendor,
      providerId: draftProviderId,
      baseUrl: draftBaseUrl,
      apiKey: draftApiKey,
      contextWindow: draftContext,
      compressionPercent: draftPercent,
      ...(editing === 'main'
        ? { mainModelId: draftModelId.trim() }
        : editing === 'router'
          ? { routerModelId: draftModelId.trim() }
          : { auditModelId: draftModelId.trim() }),
    });
    setEditing(null);
  };

  const editingMeta = editing ? TIER_META.find((t) => t.tier === editing) ?? TIER_META[0] : null;
  const isCustom = draftVendor === '__custom__';

  return (
    <div className="ink-elevated space-y-3 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">模型档位</div>
        <Feedback phase={savePhase} okText="已保存" failText="保存失败" />
      </div>
      <p className="text-[11px] leading-relaxed ink-text-faint">
         三档分工：router 决策 / main 生成 / audit 复核；非 main 档留空时回落 main。点档位卡弹悬浮窗配置模型、厂商与参数。
      </p>
      <div className="space-y-2">
        {TIER_META.map((t) => (
          <button
            key={t.tier}
            type="button"
            data-ui={`model_tier_${t.tier}`}
            data-configured={configured(t.tier)}
            onClick={() => openEditor(t.tier)}
            className="flex w-full items-center gap-3 rounded-xl border border-[var(--ink-border)] px-3 py-2.5 text-left hover:border-[var(--ink-border-strong)] hover:bg-[var(--ink-bg-surface)] cursor-pointer"
          >
            <span className="w-14 shrink-0 text-[12px] font-medium ink-text-base">{t.label}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] ink-text-muted">
              {configured(t.tier) ? valueOf(t.tier) : (t.tier === 'main' ? '必填' : '留空回落 main')}
            </span>
            <span className="shrink-0 text-[10px] ink-text-faint">配置 →</span>
          </button>
        ))}
      </div>
      {editing && editingMeta && (
        <FloaterWindow title={`配置${editingMeta.label}`} onClose={() => setEditing(null)}>
          <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
            <Field label="厂商" hint="预设厂商已适配自动带端点；自定义需填 Provider ID 与 API。">
              <Select
                value={draftVendor}
                onChange={(e) => {
                  setDraftVendor(e.target.value);
                  const v = VENDORS.find((x) => x.id === e.target.value);
                  if (v) setDraftBaseUrl(v.baseUrl);
                }}
                aria-label="厂商"
              >
                {VENDORS.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
                <option value="__custom__">自定义提供商…</option>
              </Select>
            </Field>

            {isCustom && (
              <Field label="Provider ID" hint="自定义提供商标识（适配器 key，如 my_llm）。">
                <TextInput
                  value={draftProviderId}
                  onChange={(e) => setDraftProviderId(e.target.value)}
                  placeholder="provider_id"
                  aria-label="provider_id"
                />
              </Field>
            )}

            <Field
              label="Provider API"
              hint="请求端点；预设厂商自动带默认值，可改为用户专属端点。"
            >
              <TextInput
                value={draftBaseUrl}
                onChange={(e) => setDraftBaseUrl(e.target.value)}
                placeholder="https://…"
                aria-label="provider_api"
              />
            </Field>

            <Field label="api_key" hint="留空沿用已保存密钥；仅保存不探测。">
              <TextInput
                type="password"
                value={draftApiKey}
                onChange={(e) => setDraftApiKey(e.target.value)}
                placeholder="sk-...（留空不更新）"
                aria-label="api_key"
              />
            </Field>
            <Field label={`${editingMeta.label} model_id`} hint={editingMeta.hint}>
              <TextInput
                value={draftModelId}
                onChange={(e) => setDraftModelId(e.target.value)}
                placeholder="model_id"
                aria-label={`${editing} model_id`}
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button size="xs" variant="secondary" onClick={() => void probeModels()} data-ui="model_probe">
                <RefreshCw size={10} strokeWidth={1.6} /> 探测
              </Button>
              {probePhase === 'loading' && <span className="text-[10px] ink-text-muted">探测中…</span>}
              {probePhase === 'success' && <span className="text-[10px] ink-feedback-ok">探测成功</span>}
              {probePhase === 'fail' && <span className="text-[10px] ink-feedback-fail">探测失败</span>}
              {probeNote && <span className="min-w-0 flex-1 truncate text-[10px] ink-text-faint">{probeNote}</span>}
            </div>
            <div className="space-y-2 border-t ink-border pt-3">
              <div className="text-[10px] font-medium tracking-wide ink-text-faint">上下文窗口与压缩红线</div>
              <div className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-[11px] ink-text-muted">上下文窗口</span>
                <TextInput
                  type="number"
                  value={String(draftContext)}
                  onChange={(e) => setDraftContext(Number(e.target.value) || 0)}
                  className="w-28"
                  aria-label="context_window"
                />
                <span className="text-[10px] ink-text-faint">tokens</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-[11px] ink-text-muted">压缩红线</span>
                <TextInput
                  type="number"
                  min={1}
                  max={100}
                  value={String(draftPercent)}
                  onChange={(e) => setDraftPercent(Number(e.target.value) || 0)}
                  className="w-28"
                  aria-label="compression_percent"
                />
                <span className="text-[10px] ink-text-faint">%</span>
              </div>
            </div>
            <div className="mt-auto flex justify-end gap-2 pt-2">
              <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>取消</Button>
              <Button size="xs" variant="primary" onClick={commit} data-ui="model_tier_commit">
                确定
              </Button>
            </div>
          </div>
        </FloaterWindow>
      )}
      {showPicker && (
        <FloaterWindow
          title="选择模型"
          onClose={() => setShowPicker(false)}
          initialRect={{ width: 320, height: 360 }}
        >
          <div className="flex h-full flex-col gap-2 p-4">
            <p className="text-[10px] leading-relaxed ink-text-faint">
              点击模型回填 {editingMeta?.label} 的 model_id（含上下文窗口）。
            </p>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
              {probeList.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  data-ui="model_pick"
                  onClick={() => pickModel(m)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-[var(--ink-border)] px-3 py-2 text-left hover:border-[var(--ink-border-strong)] hover:bg-[var(--ink-bg-surface)] cursor-pointer"
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] ink-text-base">{m.id}</span>
                  {m.context_window ? (
                    <span className="shrink-0 text-[10px] ink-text-faint">
                      {Math.round(m.context_window / 1024)}k
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        </FloaterWindow>
      )}
    </div>
  );
}

export function ModelSection(): JSX.Element {
  const tauri = createTauriInvoker();
  const [vendor, setVendor] = useState<string>(VENDORS[0].id);
  const [providerId, setProviderId] = useState<string>('custom_provider');
  const [baseUrl, setBaseUrl] = useState<string>(VENDORS[0].baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [mainModelId, setMainModelId] = useState('');
  const [routerModelId, setRouterModelId] = useState('');
  const [auditModelId, setAuditModelId] = useState('');
  const [contextWindow, setContextWindow] = useState<number>(DEFAULT_CONTEXT);
  const [compressionPercent, setCompressionPercent] = useState<number>(80);
  const [simulationTier, setSimulationTier] = useState<'off' | 'light' | 'full'>('light');
  const [savePhase, setSavePhase] = useState<FeedbackPhase>('idle');

  // 读回显：进入设置页时把上次保存的模型连接配置回填（api_key 掩码不回显）。
  useEffect(() => {
    if (!tauri) return;
    void tauri
      .invoke('models_config_get')
      .then((raw) => {
        const cfg = (raw ?? {}) as Record<string, unknown>;
        if (typeof cfg !== 'object') return;
        if (typeof cfg.vendor === 'string') setVendor(cfg.vendor);
        if (typeof cfg.provider_id === 'string') setProviderId(cfg.provider_id);
        if (typeof cfg.base_url === 'string') setBaseUrl(cfg.base_url);
        if (typeof cfg.main_model_id === 'string') setMainModelId(cfg.main_model_id);
        if (typeof cfg.router_model_id === 'string') setRouterModelId(cfg.router_model_id);
        if (typeof cfg.audit_model_id === 'string') setAuditModelId(cfg.audit_model_id);
        if (typeof cfg.context_window === 'number') setContextWindow(cfg.context_window);
        if (typeof cfg.compression_percent === 'number') setCompressionPercent(cfg.compression_percent);
      })
      .catch(() => undefined);
  }, [tauri]);

  // 压缩红线 = 上下文窗口 × 用户所选百分比（1%~100%）；40k 只作执行侧硬下限，不参与展示
  const redlineTokens = useMemo(() => {
    const base = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT;
    const pct = Number.isFinite(compressionPercent) ? Math.min(100, Math.max(1, compressionPercent)) : 80;
    return Math.floor((base * pct) / 100);
  }, [contextWindow, compressionPercent]);

  /** 落盘：档位确定 / 推演档切换即触发保存（不再集中「保存」按钮）。 */
  const persist = async (next: ModelSectionValue, sim: typeof simulationTier): Promise<void> => {
    setSavePhase('loading');
    try {
      const payload: Record<string, unknown> = {
        vendor: next.vendor,
        provider_id: next.vendor === '__custom__' ? next.providerId : adapterOf(next.vendor),
        base_url: next.baseUrl,
        main_model_id: next.mainModelId,
        router_model_id: next.routerModelId,
        audit_model_id: next.auditModelId,
        context_window: next.contextWindow,
        compression_percent: next.compressionPercent,
      };
      // 留空沿用已保存密钥：仅当本档填写了 key 才覆盖。
      if (next.apiKey && next.apiKey.trim()) payload.api_key = next.apiKey;
      if (tauri) {
        await Promise.all([
          tauri.invoke('models_config_put', { config: payload }),
          tauri.invoke('capability_put', { record: { simulation_tier: sim } }),
        ]);
      }
      setSavePhase('success');
      setTimeout(() => setSavePhase('idle'), 1200);
    } catch {
      setSavePhase('fail');
      setTimeout(() => setSavePhase('idle'), 2000);
    }
  };

  /** 档位编辑确定 → 即时更新状态并落盘。 */
  const handleTierCommit = (patch: Partial<ModelSectionValue>): void => {
    const next: ModelSectionValue = {
      vendor: patch.vendor ?? vendor,
      providerId: patch.providerId ?? providerId,
      baseUrl: patch.baseUrl ?? baseUrl,
      apiKey: patch.apiKey ?? apiKey,
      mainModelId: patch.mainModelId ?? mainModelId,
      routerModelId: patch.routerModelId ?? routerModelId,
      auditModelId: patch.auditModelId ?? auditModelId,
      contextWindow: patch.contextWindow ?? contextWindow,
      compressionPercent: patch.compressionPercent ?? compressionPercent,
    };
    if (patch.vendor !== undefined) setVendor(patch.vendor);
    if (patch.providerId !== undefined) setProviderId(patch.providerId);
    if (patch.baseUrl !== undefined) setBaseUrl(patch.baseUrl);
    if (patch.apiKey !== undefined && patch.apiKey.trim()) setApiKey(patch.apiKey);
    if (patch.contextWindow !== undefined) setContextWindow(patch.contextWindow);
    if (patch.compressionPercent !== undefined) setCompressionPercent(patch.compressionPercent);
    if (patch.mainModelId !== undefined) setMainModelId(patch.mainModelId);
    if (patch.routerModelId !== undefined) setRouterModelId(patch.routerModelId);
    if (patch.auditModelId !== undefined) setAuditModelId(patch.auditModelId);
    void persist(next, simulationTier);
  };

  /** 推演档切换 → 即时落盘。 */
  const handleSimChange = (tier: 'off' | 'light' | 'full'): void => {
    setSimulationTier(tier);
    void persist(
      { vendor, providerId, baseUrl, apiKey, mainModelId, routerModelId, auditModelId, contextWindow, compressionPercent },
      tier,
    );
  };

  return (
    <div className="space-y-4">
      <TierModelBlock
        value={{ vendor, providerId, baseUrl, apiKey, mainModelId, routerModelId, auditModelId, contextWindow, compressionPercent }}
        onCommit={handleTierCommit}
        savePhase={savePhase}
      />

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">推演档位</div>
        <p className="text-[10px] leading-relaxed ink-text-faint">
          分支决策的推演强度：关 / 轻探测 / 全量。推演由模型端支撑，切换即保存。
        </p>
        <div className="ink-seg">
          {(['off', 'light', 'full'] as const).map((tier) => (
            <button
              key={tier}
              type="button"
              data-ui={`sim_tier_${tier}`}
              data-active={simulationTier === tier}
              onClick={() => handleSimChange(tier)}
              className="ink-seg-item"
            >
              {tier === 'off' ? '关' : tier === 'light' ? '轻探测' : '全量'}
            </button>
          ))}
        </div>
      </div>

      <div className="ink-elevated space-y-2 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">压缩红线</div>
        <p className="text-[10px] leading-relaxed ink-text-faint">
          触发压缩 ≈ {redlineTokens.toLocaleString()} tokens（上下文窗口 × 压缩红线 %）；执行时保底下限 40k。
        </p>
        {contextWindow >= 128 * 1024 && (
          <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
            <AlertTriangle size={10} strokeWidth={1.6} aria-hidden />
            128k 以上窗口需确保模型实际支持，避免截断降级。
          </div>
        )}
      </div>
    </div>
  );
}
