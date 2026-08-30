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

import { useEffect, useMemo, useRef, useState } from 'react';

import { AlertTriangle, RefreshCw } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Field, Select, TextInput } from '@/shared/ui/Field';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';
import { FloaterWindow } from '@/components/floaters/floater_window';
import { createBackend } from '@/shared/backend/backendAdapter';

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
  { id: 'openai', label: 'OpenAI（Compatible）', adapter: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' },
  { id: 'openai_responses', label: 'OpenAI Responses', adapter: 'openai_responses', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', adapter: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'zhipu', label: '智谱 GLM', adapter: 'openai_compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'moonshot', label: 'Moonshot', adapter: 'openai_compatible', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'ollama', label: 'Ollama（本地）', adapter: 'openai_compatible', baseUrl: 'http://localhost:11434/v1' },
  { id: 'dashscope', label: 'DashScope（通义千问）', adapter: 'openai_compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'anthropic', label: 'Anthropic Messages', adapter: 'anthropic_messages', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: 'Google Gemini', adapter: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
] as const;

/** 预设厂商适配器（vendors 之外经 Provider API 自定义）。
 * 协议全名（用户可辨别的常见 API 协议）：openai_compatible（chat
 * completions）/ openai_responses（Responses）/ anthropic_messages（Messages）。
 */
function adapterOf(vendor: string): string {
  const v = VENDORS.find((x) => x.id === vendor);
  return v?.adapter ?? 'openai_compatible';
}

/** 当前编辑提供方的稳定标识（预设 id / 自定义 provider_id）。 */
function providerIdOf(vendor: string, customProviderId: string): string {
  return vendor === '__custom__' ? customProviderId : vendor;
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

/** 提供方空态引导（厂商空 → 「填入各提供方的 API 密钥即可使用其模型」+ 添加提供方）。
 *
 * 设计 §1.4 首次空态：厂商空时整页空态引导，主按钮「+添加提供方」直接进入
 * 配置流程；档位卡仍保留在下方（已有配置的局部可继续微调）。
 */
function EmptyProviderState({ onAdd }: { onAdd: () => void }): JSX.Element {
  return (
    <div className="ink-elevated flex flex-col items-center gap-2.5 px-4 py-8 text-center" data-ui="model_empty_state">
      <p className="text-[14px] font-medium ink-text-base">填入各提供方的 API 密钥即可使用其模型</p>
      <p className="max-w-md text-[11px] leading-relaxed ink-text-faint">
        配置一个模型提供方（预设厂商自动带端点，或自定义端点 + 密钥）后，即可在对话输入框选择具体模型；未配置时先以离线形态使用。
      </p>
      <Button size="sm" variant="primary" onClick={onAdd} data-ui="model_add_provider">
        + 添加提供方
      </Button>
    </div>
  );
}

/** 提供方草稿（前端编辑态；providers 数组唯一权威——provider_id 稳定标识，
 * vendor/custom_provider_id 随写随存供读回显忠实还原，壳侧/Python 忽略未知字段）。 */
interface ProviderDraft {
  provider_id: string;
  vendor: string;
  custom_provider_id: string;
  label: string;
  adapter: string;
  base_url: string;
  api_key: string;
  main_model_id: string;
  router_model_id: string;
  audit_model_id: string;
  context_window: number;
  compression_percent: number;
}

function blankProvider(seed: string): ProviderDraft {
  const vendor = VENDORS[0];
  return {
    provider_id: seed,
    vendor: vendor.id,
    custom_provider_id: 'custom_provider',
    label: vendor.label,
    adapter: vendor.adapter,
    base_url: vendor.baseUrl,
    api_key: '',
    main_model_id: '',
    router_model_id: '',
    audit_model_id: '',
    context_window: DEFAULT_CONTEXT,
    compression_percent: 80,
  };
}

function providerToJson(p: ProviderDraft): Record<string, unknown> {
  return {
    provider_id: p.provider_id,
    vendor: p.vendor,
    custom_provider_id: p.custom_provider_id,
    label: p.label,
    adapter: p.adapter,
    base_url: p.base_url,
    model_ids: {
      ...(p.main_model_id ? { main: p.main_model_id } : {}),
      ...(p.router_model_id ? { router: p.router_model_id } : {}),
      ...(p.audit_model_id ? { audit: p.audit_model_id } : {}),
    },
    context_window: p.context_window,
    compression_percent: p.compression_percent,
    ...(p.api_key && p.api_key.trim() ? { api_key: p.api_key } : {}),
  };
}

function providerFromJson(raw: unknown, index: number): ProviderDraft {
  const p = (raw ?? {}) as Record<string, unknown>;
  const modelIds = (p.model_ids ?? {}) as Record<string, unknown>;
  const providerId = typeof p.provider_id === 'string' && p.provider_id ? p.provider_id : `provider_${index}`;
  // vendor 字段缺省（旧数据）→ 按 provider_id 映射预设，否则自定义
  const vendor =
    typeof p.vendor === 'string' && p.vendor
      ? p.vendor
      : VENDORS.some((v) => v.id === providerId)
        ? providerId
        : '__custom__';
  return {
    provider_id: providerId,
    vendor,
    custom_provider_id:
      typeof p.custom_provider_id === 'string'
        ? p.custom_provider_id
        : (typeof p.provider_id === 'string' ? p.provider_id : 'custom_provider'),
    label:
      typeof p.label === 'string' && p.label
        ? p.label
        : (VENDORS.find((v) => v.id === vendor)?.label ?? providerId),
    adapter: typeof p.adapter === 'string' ? p.adapter : 'openai_compatible',
    base_url: typeof p.base_url === 'string' ? p.base_url : '',
    api_key: '', // 掩码不回显
    main_model_id: typeof modelIds.main === 'string' ? modelIds.main : '',
    router_model_id: typeof modelIds.router === 'string' ? modelIds.router : '',
    audit_model_id: typeof modelIds.audit === 'string' ? modelIds.audit : '',
    context_window: typeof p.context_window === 'number' ? p.context_window : DEFAULT_CONTEXT,
    compression_percent: typeof p.compression_percent === 'number' ? p.compression_percent : 80,
  };
}

/** 提供方列表（多卡：选中切换编辑 / 添加 / 删除；已配置主档模型摘要展示）。 */
function ProviderList({
  providers,
  activeProviderId,
  onSelect,
  onAdd,
  onDelete,
}: {
  providers: ProviderDraft[];
  activeProviderId: string | null;
  onSelect: (providerId: string) => void;
  onAdd: () => void;
  onDelete: (providerId: string) => void;
}): JSX.Element {
  return (
    <div className="ink-elevated space-y-2.5 px-3.5 py-3" data-ui="provider_list">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">提供方</div>
        <Button size="xs" variant="ghost" onClick={onAdd} data-ui="provider_add">
          + 添加提供方
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {providers.map((p) => (
          <button
            key={p.provider_id}
            type="button"
            data-active={p.provider_id === activeProviderId}
            data-ui="provider_card"
            onClick={() => onSelect(p.provider_id)}
            className="flex items-center gap-2 rounded-lg border border-[var(--ink-border)] px-2.5 py-1.5 text-[11px] ink-text-muted hover:border-[var(--ink-border-strong)] hover:bg-[var(--ink-bg-surface)] data-[active=true]:border-[var(--ink-accent-border)] data-[active=true]:text-[var(--ink-text-base)]"
          >
            <span className="max-w-[7rem] truncate">{p.label || p.provider_id}</span>
            <span className="max-w-[6rem] truncate text-[10px] ink-text-faint">
              {p.main_model_id || '未配置'}
            </span>
            <span
              role="button"
              aria-label={`删除 ${p.label || p.provider_id}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(p.provider_id);
              }}
              className="ml-0.5 shrink-0 ink-text-faint hover:text-[var(--ink-text-base)]"
            >
              ×
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TierModelBlock({
  value,
  onCommit,
  savePhase,
  autoOpenMainPulse,
}: {
  value: ModelSectionValue;
  onCommit: (patch: Partial<ModelSectionValue>) => void;
  savePhase: FeedbackPhase;
  /** 空态「添加提供方」脉冲（自增计数：每次点击重新打开 main 档配置悬浮窗）。 */
  autoOpenMainPulse?: number;
}): JSX.Element {
  const backend = useMemo(() => createBackend(), []);
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

  // 空态「添加提供方」脉冲 → 打开 main 档配置悬浮窗（从空态引导进入配置）。
  useEffect(() => {
    if (autoOpenMainPulse && autoOpenMainPulse > 0) openEditor('main');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenMainPulse]);

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

  /** 探测端点模型列表 → 弹悬浮窗供选择（经壳 models_refresh：壳进程内
   *  发起 HTTP，规避浏览器 CORS；结果落模型档案库，再经 archive 快照回读）。 */
  const probeModels = async (): Promise<void> => {
    setProbePhase('loading');
    setProbeNote('');
    try {
      if (!backend.available) throw new Error('宿主不可用');
      // 壳侧 normalize_models_url 为 base_url + '/models'；Anthropic 需
      // 显式带 /v1 前缀（api.anthropic.com/models 非有效端点）。
      const probeBase = draftVendor === 'anthropic'
        ? `${draftBaseUrl.replace(/\/+$/, '')}/v1`
        : draftBaseUrl;
      await backend.modelsRefresh({
        base_url: probeBase,
        api_key: draftApiKey || undefined,
        provider_id: providerIdOf(draftVendor, draftProviderId),
        models: [],
      });
      const archive = (await backend.modelArchiveSnapshot()) as unknown as {
        archives?: Array<{ model_id: string; context_window?: number }>;
      };
      const models = (archive?.archives ?? []).map((m) => ({
        id: m.model_id,
        context_window: m.context_window,
      }));
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
  const backend = useMemo(() => createBackend(), []);
  // 多提供方：providers 数组（唯一权威）+ 当前编辑提供方
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [simulationTier, setSimulationTier] = useState<'off' | 'light' | 'full'>('light');
  const [savePhase, setSavePhase] = useState<FeedbackPhase>('idle');
  // 提供方是否已配置（null = 尚未读回显；false = 空态引导）。
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null);
  // 空态/列表「添加提供方」脉冲（自增计数触发 main 档悬浮窗打开）。
  const [addProviderPulse, setAddProviderPulse] = useState(0);

  const activeProvider = providers.find((p) => p.provider_id === activeProviderId) ?? providers[0];

  // 当前编辑提供方 → 档位编辑器入参（ModelSectionValue 扁平形态）
  const activeValue: ModelSectionValue = activeProvider
    ? {
        vendor: activeProvider.vendor,
        providerId: activeProvider.custom_provider_id,
        baseUrl: activeProvider.base_url,
        apiKey: activeProvider.api_key,
        mainModelId: activeProvider.main_model_id,
        routerModelId: activeProvider.router_model_id,
        auditModelId: activeProvider.audit_model_id,
        contextWindow: activeProvider.context_window,
        compressionPercent: activeProvider.compression_percent,
      }
    : {
        vendor: VENDORS[0].id,
        providerId: 'custom_provider',
        baseUrl: VENDORS[0].baseUrl,
        apiKey: '',
        mainModelId: '',
        routerModelId: '',
        auditModelId: '',
        contextWindow: DEFAULT_CONTEXT,
        compressionPercent: 80,
      };

  // 用 ref 持久化最新表单闭包，避免 handleSimChange 读到过期渲染闭包。
  const formRef = useRef<ModelSectionValue>(activeValue);
  formRef.current = activeValue;

  // 标记推演档是否经用户切换（排除初始挂载）。
  const simTouchedRef = useRef(false);

  // 推演档切换 → 读取最新表单值即时落盘（effect 在 committed state 上运行，无闭包过期）。
  useEffect(() => {
    if (!simTouchedRef.current) return;
    void persist(providers, simulationTier);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationTier]);

  // 读回显：providers 数组（多提供方唯一权威）；旧 flat 形态投影为单提供方。
  useEffect(() => {
    if (!backend.available) return;
    void backend
      .modelsConfigGet()
      .then((raw) => {
        const cfg = (raw ?? {}) as Record<string, unknown>;
        if (typeof cfg !== 'object') return;
        const isProvidersForm = Array.isArray(cfg.providers);
        // 空配置（{}）→ 无提供方（空态引导）；旧 flat 形态投影为单提供方
        const list: ProviderDraft[] = isProvidersForm
          ? (cfg.providers as unknown[]).map((p, i) => providerFromJson(p, i))
          : Object.keys(cfg).length > 0
            ? [providerFromJson(cfg, 0)]
            : [];
        setProviders(list);
        setActiveProviderId(list[0]?.provider_id ?? null);
        // 提供方已配置判定（任一提供方端点 + 主档 model_id 齐备）；空态引导数据面
        setProviderConfigured(
          list.some((p) => p.base_url.trim() && p.main_model_id.trim()),
        );
      })
      .catch(() => setProviderConfigured(false));
  }, [backend]);

  // 压缩红线 = 当前编辑提供方上下文窗口 × 百分比（1%~100%）；40k 只作执行侧硬下限
  const redlineTokens = useMemo(() => {
    const base = activeProvider?.context_window && activeProvider.context_window > 0 ? activeProvider.context_window : DEFAULT_CONTEXT;
    const pct = Number.isFinite(activeProvider?.compression_percent) ? Math.min(100, Math.max(1, activeProvider?.compression_percent ?? 80)) : 80;
    return Math.floor((base * pct) / 100);
  }, [activeProvider]);

  /** 落盘：全量提供方数组（档位确定 / 推演档切换即触发保存，不再集中「保存」按钮）。
   * 壳侧按 provider_id 逐提供方浅合并——api_key 未重填沿用已存值。 */
  const persist = async (list: ProviderDraft[], sim: typeof simulationTier): Promise<void> => {
    setSavePhase('loading');
    try {
      const payload = { providers: list.map(providerToJson) };
      if (backend.available) {
        await Promise.all([
          backend.modelsConfigPut(payload),
          backend.capabilityPut({ simulation_tier: sim }),
        ]);
      }
      setProviderConfigured(
        list.some((p) => p.base_url.trim() && p.main_model_id.trim()),
      );
      setSavePhase('success');
      setTimeout(() => setSavePhase('idle'), 1200);
    } catch {
      setSavePhase('fail');
      setTimeout(() => setSavePhase('idle'), 2000);
    }
  };

  /** 档位编辑确定 → 更新当前提供方并即时落盘。 */
  const handleTierCommit = (patch: Partial<ModelSectionValue>): void => {
    if (!activeProvider) return;
    const nextList = providers.map((p) => {
      if (p.provider_id !== activeProvider.provider_id) return p;
      const next: ProviderDraft = {
        ...p,
        vendor: patch.vendor ?? p.vendor,
        custom_provider_id: patch.providerId ?? p.custom_provider_id,
        base_url: patch.baseUrl ?? p.base_url,
        main_model_id: patch.mainModelId ?? p.main_model_id,
        router_model_id: patch.routerModelId ?? p.router_model_id,
        audit_model_id: patch.auditModelId ?? p.audit_model_id,
        context_window: patch.contextWindow ?? p.context_window,
        compression_percent: patch.compressionPercent ?? p.compression_percent,
      };
      if (patch.apiKey && patch.apiKey.trim()) next.api_key = patch.apiKey;
      // 厂商切换 → adapter/label 跟随（provider_id 保持稳定，避免已存配置身份漂移）
      if (patch.vendor !== undefined) {
        next.adapter = patch.vendor === '__custom__' ? next.custom_provider_id : adapterOf(patch.vendor);
        next.label = patch.vendor === '__custom__' ? next.custom_provider_id : (VENDORS.find((v) => v.id === patch.vendor)?.label ?? patch.vendor);
      }
      return next;
    });
    setProviders(nextList);
    void persist(nextList, simulationTier);
  };

  /** 添加提供方：追加默认草稿 → 选中 → 打开 main 档配置悬浮窗（空态/列表同入口）。 */
  const handleAddProvider = (): void => {
    const seed = providers.some((p) => p.provider_id === VENDORS[0].id)
      ? `${VENDORS[0].id}_${providers.length}`
      : VENDORS[0].id;
    const nextList = [...providers, blankProvider(seed)];
    setProviders(nextList);
    setActiveProviderId(seed);
    setProviderConfigured(false);
    setAddProviderPulse((n) => n + 1);
  };

  /** 删除提供方（可删至空——空态引导覆盖无提供方场景）。 */
  const handleDeleteProvider = (providerId: string): void => {
    const nextList = providers.filter((p) => p.provider_id !== providerId);
    setProviders(nextList);
    if (activeProviderId === providerId) setActiveProviderId(nextList[0]?.provider_id ?? null);
    void persist(nextList, simulationTier);
  };

  /** 推演档切换 → setSimulationTier 触发 effect 持久化（读 formRef 最新值，无闭包过期）。 */
  const handleSimChange = (tier: 'off' | 'light' | 'full'): void => {
    simTouchedRef.current = true;
    setSimulationTier(tier);
  };

  return (
    <div className="space-y-4">
      {providerConfigured === false && providers.length === 0 && (
        <EmptyProviderState onAdd={handleAddProvider} />
      )}
      {providers.length > 0 && (
        <ProviderList
          providers={providers}
          activeProviderId={activeProvider?.provider_id ?? null}
          onSelect={setActiveProviderId}
          onAdd={handleAddProvider}
          onDelete={handleDeleteProvider}
        />
      )}
      {activeProvider && (
        <TierModelBlock
          value={activeValue}
          onCommit={handleTierCommit}
          savePhase={savePhase}
          autoOpenMainPulse={addProviderPulse}
        />
      )}

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
        {(activeProvider?.context_window ?? DEFAULT_CONTEXT) >= 128 * 1024 && (
          <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
            <AlertTriangle size={10} strokeWidth={1.6} aria-hidden />
            128k 以上窗口需确保模型实际支持，避免截断降级。
          </div>
        )}
      </div>
    </div>
  );
}
