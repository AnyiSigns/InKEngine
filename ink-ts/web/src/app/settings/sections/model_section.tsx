// gate: 超限(846 行) - 模型连接配置节（单节表单：角色槽/提供方/自定义/全局阈值同面）
/**
 * 设置「模型」节：提供方管理（模板/自定义协议）+ router 档位模型选择 +
 * 推演档位 + 全局压缩阈值。
 *
 * 布局（自上而下，参考「模型」页）：
 *  1. 已连接提供方列表（名称 + 状态点 + 编辑/删除）；
 *  2. `+ 添加提供方`（已适配厂商模板，自动带端点）与 `+ 添加自定义提供方`
 *     （按 API 协议添加，用户填端点 + Provider ID）；
 *  3. router 档位模型选择（下拉复选框，从全部已添加模型列表勾选）；
 *  4. 推演档位（关/轻探测/全量）；
 *  5. 自动压缩阈值（全局单值，页面级，三档共用）。
 *
 * 档位语义（引擎角色槽收口为 agent/router）：agent = 对话主模型，是对话页
 * 输入框的自选模型（协作者仍经 EntitySpec.model 指定），不在设置页占档位；
 * 本页只配 router（决策档）。model_ids 按 providers[].model_ids.router 落盘
 * （引擎挡位链按当前连接读取），全局压缩阈值经 providers[].compression_percent
 * 落盘（后端取首提供方 = 当前连接）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { AlertTriangle, Check, ChevronDown, Plus } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Field, Select, TextInput } from '@/shared/ui/Field';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';
import { FloaterWindow } from '@/components/floaters/floater_window';
import { createBackend } from '@/shared/backend/backendAdapter';

/** 已适配厂商模板（具体厂商，自动带端点；协议经 vendor 绑定，不与协议混列）。 */
const VENDORS = [
  { id: 'openai', label: 'OpenAI', adapter: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', adapter: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'zhipu', label: '智谱 GLM', adapter: 'openai_compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'moonshot', label: 'Moonshot', adapter: 'openai_compatible', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'ollama', label: 'Ollama（本地）', adapter: 'openai_compatible', baseUrl: 'http://localhost:11434/v1' },
  { id: 'dashscope', label: 'DashScope（通义千问）', adapter: 'openai_compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'anthropic', label: 'Anthropic', adapter: 'anthropic_messages', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: 'Google Gemini', adapter: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
] as const;

/** API 协议（自定义提供方按此添加；厂商模板经 vendor 绑定协议，不再混列）。 */
const PROTOCOLS = [
  { id: 'openai_compatible', label: 'OpenAI 兼容（Chat Completions）' },
  { id: 'openai_responses', label: 'OpenAI Responses' },
  { id: 'anthropic_messages', label: 'Anthropic Messages' },
  { id: 'gemini', label: 'Google Gemini' },
] as const;

/** 旧模板 id（曾为厂商模板的协议变体）→ 迁移到实际厂商模板并保留其协议。 */
const LEGACY_TEMPLATE_PROTOCOL: Record<string, { vendor: string; adapter: string }> = {
  openai_responses: { vendor: 'openai', adapter: 'openai_responses' },
};

function adapterOfTemplate(vendor: string): string {
  return VENDORS.find((v) => v.id === vendor)?.adapter ?? 'openai_compatible';
}

const DEFAULT_CONTEXT = 128 * 1024;

/** 提供方草稿（前端编辑态；providers 数组唯一权威）。 */
interface ProviderDraft {
  provider_id: string;
  vendor: string;
  custom_provider_id: string;
  label: string;
  adapter: string;
  base_url: string;
  api_key: string;
  /** 该提供方已添加的模型清单（probing 默认全选 + 自定义 model_id）。 */
  models: string[];
  router_model_id: string;
  context_window: number;
  compression_percent: number;
}

/** 提供方落盘（agent = 对话主模型随输入框自选，不写此档位；只写 router + models + 全局压缩）。 */
function providerToJson(p: ProviderDraft, globalCompression: number): Record<string, unknown> {
  return {
    provider_id: p.provider_id,
    vendor: p.vendor,
    custom_provider_id: p.custom_provider_id,
    label: p.label,
    adapter: p.adapter,
    base_url: p.base_url,
    model_ids: {
      ...(p.router_model_id ? { router: p.router_model_id } : {}),
    },
    models: p.models,
    context_window: p.context_window,
    compression_percent: globalCompression,
    ...(p.api_key && p.api_key.trim() ? { api_key: p.api_key } : {}),
  };
}

function providerFromJson(raw: unknown, index: number): ProviderDraft {
  const p = (raw ?? {}) as Record<string, unknown>;
  const modelIds = (p.model_ids ?? {}) as Record<string, unknown>;
  const providerId = typeof p.provider_id === 'string' && p.provider_id ? p.provider_id : `provider_${index}`;
  const rawVendor =
    typeof p.vendor === 'string' && p.vendor
      ? p.vendor
      : VENDORS.some((v) => v.id === providerId)
        ? providerId
        : '__custom__';
  // 旧协议变体模板 id（如 openai_responses）→ 迁移到实际厂商模板，保留协议。
  const legacy = LEGACY_TEMPLATE_PROTOCOL[rawVendor];
  const vendor = legacy ? legacy.vendor : rawVendor;
  const retainedAdapter = legacy ? legacy.adapter : undefined;
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
    adapter: retainedAdapter ?? (typeof p.adapter === 'string' ? p.adapter : adapterOfTemplate(vendor)),
    base_url: typeof p.base_url === 'string' ? p.base_url : '',
    api_key: '',
    models: Array.isArray(p.models) ? (p.models as unknown[]).map((m) => String(m)) : [],
    router_model_id: typeof modelIds.router === 'string' ? modelIds.router : '',
    context_window: typeof p.context_window === 'number' ? p.context_window : DEFAULT_CONTEXT,
    compression_percent: typeof p.compression_percent === 'number' ? p.compression_percent : 80,
  };
}

/** 提供方列表（名称 + 绿点 + 编辑/删除）。 */
function ProviderList({
  providers,
  activeProviderId,
  onSelect,
  onEdit,
  onDelete,
  onAddTemplate,
  onAddCustom,
}: {
  providers: ProviderDraft[];
  activeProviderId: string | null;
  onSelect: (providerId: string) => void;
  onEdit: (providerId: string) => void;
  onDelete: (providerId: string) => void;
  onAddTemplate: () => void;
  onAddCustom: () => void;
}): JSX.Element {
  return (
    <div className="ink-elevated space-y-2.5 px-3.5 py-3" data-ui="provider_list">
      <div className="text-[11px] font-medium tracking-wide ink-text-muted">提供方</div>
      <div className="space-y-2">
        {providers.map((p) => (
          <div
            key={p.provider_id}
            data-active={p.provider_id === activeProviderId}
            data-ui="provider_row"
            className="flex items-center gap-2.5 rounded-xl border border-[var(--ink-border)] px-3 py-2.5 hover:border-[var(--ink-border-strong)] data-[active=true]:border-[var(--ink-accent-border)]"
          >
            <button
              type="button"
              onClick={() => onSelect(p.provider_id)}
              className="min-w-0 flex-1 text-left cursor-pointer"
            >
              <span className="flex items-center gap-2 text-[13px] font-medium ink-text-base">
                <span className="truncate">{p.label || p.provider_id}</span>
                <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--ink-feedback-ok)]" aria-label="已连接" />
              </span>
              <span className="mt-0.5 block truncate text-[10px] ink-text-faint">{p.base_url}</span>
            </button>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="xs" variant="secondary" onClick={() => onEdit(p.provider_id)} data-ui="provider_edit">
                编辑
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="ink-accent hover:text-[var(--ink-feedback-fail)]"
                onClick={() => onDelete(p.provider_id)}
                data-ui="provider_delete"
              >
                删除
              </Button>
            </div>
          </div>
        ))}
        {providers.length === 0 && (
          <p className="px-1 py-2 text-[11px] ink-text-faint">暂无提供方，请添加一个提供方以使用模型。</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 pt-1">
        <button
          type="button"
          onClick={onAddTemplate}
          data-ui="provider_add_template"
          className="flex items-center justify-center gap-1 rounded-xl border border-dashed ink-border px-3 py-2.5 text-[12px] ink-text-muted hover:border-[var(--ink-border-strong)] hover:bg-[var(--ink-bg-surface)] cursor-pointer"
        >
          <Plus size={13} strokeWidth={1.6} aria-hidden /> + 添加提供方
        </button>
        <button
          type="button"
          onClick={onAddCustom}
          data-ui="provider_add_custom"
          className="flex items-center justify-center gap-1 rounded-xl border border-dashed ink-border px-3 py-2.5 text-[12px] ink-text-muted hover:border-[var(--ink-border-strong)] hover:bg-[var(--ink-bg-surface)] cursor-pointer"
        >
          <Plus size={13} strokeWidth={1.6} aria-hidden /> + 添加自定义提供方
        </button>
      </div>
    </div>
  );
}

/** 档位模型选择（下拉复选框：从全部已添加模型清单中勾选档位模型）。 */
function TierModelSelect({
  tier,
  label,
  hint,
  value,
  models,
  onChange,
}: {
  tier: string;
  label: string;
  hint: string;
  value: string;
  models: string[];
  onChange: (modelId: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="space-y-1.5" ref={ref} data-ui={`tier_model_${tier}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium ink-text-base">{label}</span>
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={open}
            data-ui={`tier_model_toggle_${tier}`}
            className="flex h-7 min-w-[9rem] items-center justify-between gap-1 rounded-lg border ink-border px-2 text-[11px] ink-text-muted hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
          >
            <span className={value ? 'ink-text-base' : 'ink-text-faint'}>
              {value || '未选择'}
            </span>
            <ChevronDown size={12} strokeWidth={1.6} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <div className="ink-menu-pop ink-menu-pop-right ink-menu-pop-up absolute right-0 z-20 max-h-56 w-72 overflow-y-auto" role="listbox">
              {models.length === 0 && <div className="px-3 py-2 text-[10px] ink-text-faint">暂无已添加模型</div>}
              {models.map((m) => {
                const checked = m === value;
                return (
                  <button
                    key={m}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => { onChange(m); setOpen(false); }}
                    className="ink-menu-item flex items-center gap-2"
                  >
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ink-border">
                      {checked && <Check size={10} strokeWidth={2} className="ink-text-base" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{m}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <p className="text-[10px] leading-relaxed ink-text-faint">{hint}</p>
    </div>
  );
}

interface ProbeModel {
  id: string;
  context_window?: number;
}

/** 添加/编辑提供方弹窗（模板 / 自定义协议；填 url 自动探测 → 模型默认全选）。 */
function AddProviderModal({
  mode,
  initial,
  globalCompression,
  onCommit,
  onClose,
}: {
  mode: 'template' | 'custom';
  initial?: ProviderDraft;
  globalCompression: number;
  onCommit: (draft: ProviderDraft) => void;
  onClose: () => void;
}): JSX.Element {
  const backend = useMemo(() => createBackend(), []);
  const isCustom = mode === 'custom';
  const [vendor, setVendor] = useState(initial?.vendor ?? (isCustom ? '__custom__' : VENDORS[0].id));
  const [protocol, setProtocol] = useState(initial?.adapter ?? 'openai_compatible');
  const [providerId, setProviderId] = useState(initial?.custom_provider_id ?? (isCustom ? 'custom_provider' : ''));
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? (isCustom ? '' : VENDORS[0].baseUrl));
  const [apiKey, setApiKey] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [probed, setProbed] = useState<ProbeModel[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [probePhase, setProbePhase] = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');
  const [probeNote, setProbeNote] = useState('');
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeSeq = useRef(0);

  const probe = async (url: string): Promise<void> => {
    if (!url.trim()) {
      probeSeq.current += 1;
      setProbed([]);
      setChecked(new Set());
      setProbePhase('idle');
      return;
    }
    const seq = probeSeq.current + 1;
    probeSeq.current = seq;
    setProbePhase('loading');
    try {
      if (!backend.available) throw new Error('宿主不可用');
      const probeBase = vendor === 'anthropic' ? `${url.replace(/\/+$/, '')}/v1` : url;
      await backend.modelsRefresh({
        base_url: probeBase,
        api_key: apiKey || undefined,
        provider_id: vendor === '__custom__' ? providerId : vendor,
        models: [],
      });
      const archive = (await backend.modelArchiveSnapshot()) as unknown as {
        archives?: Array<{ model_id: string; context_window?: number }>;
      };
      if (seq !== probeSeq.current) return;
      const list = (archive?.archives ?? []).map((m) => ({ id: m.model_id, context_window: m.context_window }));
      setProbed(list);
      setChecked(new Set(list.map((m) => m.id)));
      setProbePhase('success');
      setProbeNote(`探测到 ${list.length} 个模型，默认全部勾选`);
    } catch {
      if (seq !== probeSeq.current) return;
      setProbePhase('fail');
      setProbeNote('探测失败：检查端点与密钥');
    }
  };

  useEffect(() => () => {
    if (probeTimer.current) clearTimeout(probeTimer.current);
  }, []);

  const handleUrlChange = (url: string): void => {
    setBaseUrl(url);
    if (probeTimer.current) clearTimeout(probeTimer.current);
    probeTimer.current = setTimeout(() => void probe(url), 600);
  };

  const toggle = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addCustomModel = (): void => {
    const id = customModel.trim();
    if (!id) return;
    if (checked.has(id)) { setCustomModel(''); return; }
    if (!probed.some((m) => m.id === id)) {
      setProbed((prev) => [...prev, { id, context_window: undefined }]);
    }
    setChecked((prev) => new Set(prev).add(id));
    setCustomModel('');
  };

  const commit = (): void => {
    // 模板模式：adapter = 厂商模板绑定的协议（不写 vendor id）；自定义模式：adapter = 所选协议。
    const adapter = isCustom || vendor === '__custom__' ? protocol : adapterOfTemplate(vendor);
    const actualProviderId = isCustom || vendor === '__custom__' ? providerId : vendor;
    const label = isCustom || vendor === '__custom__' ? providerId : (VENDORS.find((v) => v.id === vendor)?.label ?? vendor);
    onCommit({
      provider_id: initial?.provider_id ?? actualProviderId,
      vendor,
      custom_provider_id: providerId || 'custom_provider',
      label,
      adapter,
      base_url: baseUrl,
      api_key: apiKey,
      models: Array.from(checked),
      router_model_id: initial?.router_model_id ?? '',
      context_window: initial?.context_window ?? DEFAULT_CONTEXT,
      compression_percent: globalCompression,
    });
  };

  const title = initial ? `编辑${initial.label || initial.provider_id}` : isCustom ? '添加自定义提供方' : '添加提供方';

  return (
    <FloaterWindow title={title} onClose={onClose} dataUi="provider_modal">
      <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
        {!isCustom ? (
          <Field label="厂商模板" hint="已适配厂商，自动带默认端点。">
            <Select
              value={vendor}
              onChange={(e) => {
                const v = e.target.value;
                setVendor(v);
                const tpl = VENDORS.find((x) => x.id === v);
                if (tpl) { setBaseUrl(tpl.baseUrl); setProtocol(tpl.adapter); }
              }}
              aria-label="厂商模板"
            >
              {VENDORS.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="API 协议" hint="按协议接入自定义端点。">
            <Select value={protocol} onChange={(e) => setProtocol(e.target.value)} aria-label="API 协议">
              {PROTOCOLS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </Select>
          </Field>
        )}

        {isCustom && (
          <Field label="Provider ID" hint="自定义提供商标识（适配器 key，如 my_llm）。">
            <TextInput
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              placeholder="provider_id"
              aria-label="provider_id"
            />
          </Field>
        )}

        <Field label="Provider URL" hint="填 URL 自动探测模型清单。">
          <TextInput
            value={baseUrl}
            onChange={(e) => handleUrlChange(e.target.value)}
            placeholder="https://…"
            aria-label="provider_url"
          />
        </Field>

        <Field label="api_key" hint="只在重填时更新，留空沿用已保存密钥。">
          <TextInput
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-...（留空不更新）"
            aria-label="api_key"
          />
        </Field>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <TextInput
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="自定义 model_id"
              aria-label="custom_model_id"
              className="flex-1"
            />
            <Button size="xs" variant="secondary" onClick={addCustomModel} data-ui="custom_model_add">
              <Plus size={11} strokeWidth={1.8} /> 添加
            </Button>
          </div>
          <p className="text-[10px] leading-relaxed ink-text-faint">
            {probePhase === 'loading' && '探测中…'}
            {probePhase === 'success' && probeNote}
            {probePhase === 'fail' && probeNote}
            {probePhase === 'idle' && '填 URL 后自动探测模型；默认全勾选加入该提供方。'}
          </p>
          {probed.length > 0 && (
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border ink-border p-2" data-ui="probed_model_list">
              {probed.map((m) => (
                <label
                  key={m.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] ink-text-muted hover:bg-[var(--ink-bg-surface)]"
                >
                  <input
                    type="checkbox"
                    checked={checked.has(m.id)}
                    onChange={() => toggle(m.id)}
                    className="accent-[var(--ink-accent-approval)]"
                    aria-label={`选择模型 ${m.id}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{m.id}</span>
                  {m.context_window ? (
                    <span className="shrink-0 text-[10px] ink-text-faint">{Math.round(m.context_window / 1024)}k</span>
                  ) : null}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="mt-auto flex justify-end gap-2 pt-2">
          <Button size="xs" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="xs" variant="primary" onClick={commit} data-ui="provider_commit">确定</Button>
        </div>
      </div>
    </FloaterWindow>
  );
}

export function ModelSection(): JSX.Element {
  const backend = useMemo(() => createBackend(), []);
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [simulationTier, setSimulationTier] = useState<'off' | 'light' | 'full'>('light');
  const [savePhase, setSavePhase] = useState<FeedbackPhase>('idle');
  const [globalCompression, setGlobalCompression] = useState(80);
  const [modal, setModal] = useState<{ mode: 'template' | 'custom'; providerId?: string } | null>(null);

  const activeProvider = providers.find((p) => p.provider_id === activeProviderId) ?? providers[0];

  const [routerModelId, setRouterModelId] = useState('');
  const [archiveModels, setArchiveModels] = useState<string[]>([]);

  // 模型清单 = 当前（激活）提供方的已勾选 models ∪ 档案库（旧数据兜底）；
  // 换当前提供方后档位候选随当前连接切换（不再跨提供方并集——档位模型
  // 归属当前连接，候选同样只列当前连接可用的模型，配错端点必失败的场景消除）。
  useEffect(() => {
    if (!backend.available) return;
    void backend
      .modelArchiveSnapshot()
      .then((snap) => {
        const s = snap as unknown as { archives?: Array<{ model_id?: string }> };
        setArchiveModels((s?.archives ?? []).map((m) => m.model_id).filter((x): x is string => Boolean(x)));
      })
      .catch(() => undefined);
  }, [backend]);

  const allModels = useMemo(() => {
    const current = activeProvider?.models ?? [];
    const fromCurrent = Array.isArray(current) ? current : [];
    // 候选 = 当前提供方模型清单；无清单（旧配置/未探测补录）才回落全局
    // 档案，避免跨提供方候选与端点错配（当前连接消费 providers[0] 同源）。
    if (fromCurrent.length > 0) {
      return Array.from(new Set(fromCurrent)).sort((a, b) => a.localeCompare(b));
    }
    return Array.from(new Set(archiveModels)).sort((a, b) => a.localeCompare(b));
  }, [activeProvider, archiveModels]);

  const simTouchedRef = useRef(false);
  const readyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  useEffect(() => {
    if (!simTouchedRef.current || !readyRef.current) return;
    void persist(providers, simulationTier, globalCompression);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationTier]);

  useEffect(() => {
    if (!readyRef.current) return;
    void persist(providers, simulationTier, globalCompression);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalCompression]);

  useEffect(() => {
    if (!backend.available) return;
    void backend
      .modelsConfigGet()
      .then((raw) => {
        const cfg = (raw ?? {}) as Record<string, unknown>;
        if (typeof cfg !== 'object') return;
        const isProvidersForm = Array.isArray(cfg.providers);
        const list: ProviderDraft[] = isProvidersForm
          ? (cfg.providers as unknown[]).map((p, i) => providerFromJson(p, i))
          : Object.keys(cfg).length > 0
            ? [providerFromJson(cfg, 0)]
            : [];
        setProviders(list);
        setActiveProviderId(list[0]?.provider_id ?? null);
        if (list[0]) {
          setRouterModelId(list[0].router_model_id);
          setGlobalCompression(list[0].compression_percent || 80);
        }
        readyRef.current = true;
        void backend
          .capabilityGet()
          .then((cap) => {
            const t = (cap ?? {}).simulation_tier;
            if ((t === 'off' || t === 'light' || t === 'full') && !simTouchedRef.current) {
              setSimulationTier(t);
            }
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
  }, [backend]);

  const persist = async (list: ProviderDraft[], sim: typeof simulationTier, compression: number): Promise<void> => {
    setSavePhase('loading');
    try {
      const payload = { providers: list.map((p) => providerToJson(p, compression)) };
      if (backend.available) {
        // 推演档位只在用户显式触碰后随保存写入（simTouchedRef）：未设置的
        // 用户做无关保存（改模型档/压缩/提供方）不写档，避免把本地默认
        // 档静默固化进能力记录。
        const ops = [backend.modelsConfigPut(payload)];
        if (simTouchedRef.current) {
          ops.push(backend.capabilityPut({ simulation_tier: sim }));
        }
        await Promise.all(ops);
      }
      setSavePhase('success');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSavePhase('idle'), 1200);
    } catch {
      setSavePhase('fail');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSavePhase('idle'), 2000);
    }
  };

  const syncTierModels = (next: { router?: string }): void => {
    if (next.router !== undefined) setRouterModelId(next.router);
    const current = activeProvider;
    if (!current) return;
    const nextCurrent: ProviderDraft = {
      ...current,
      router_model_id: next.router ?? current.router_model_id,
    };
    const nextList = replaceProvider(nextCurrent);
    setProviders(nextList);
    void persist(nextList, simulationTier, globalCompression);
  };

  /** 替换指定提供方（按 provider_id；缺席追加——当前提供方落位保持）。
   *  档位编辑归属 = 当前（激活）提供方：入参已是当前项的更新副本。 */
  const replaceProvider = (draft: ProviderDraft): ProviderDraft[] =>
    providers.some((p) => p.provider_id === draft.provider_id)
      ? providers.map((p) => (p.provider_id === draft.provider_id ? draft : p))
      : [...providers, draft];

  /** 切换当前提供方（点选即设当前连接）：选中项升为 providers[0] 并落盘。
   *  引擎消费 providers[0]（当前连接解析同源）——换提供方后档位候选与
   *  消费同步切换，不在「显示 A、消费 B」的错配上编辑档位。 */
  const makeCurrent = (providerId: string): void => {
    if (providerId === (activeProvider?.provider_id ?? providers[0]?.provider_id)) return;
    const target = providers.find((p) => p.provider_id === providerId);
    if (!target) return;
    const nextList = [target, ...providers.filter((p) => p.provider_id !== providerId)];
    setProviders(nextList);
    setActiveProviderId(providerId);
    setRouterModelId(target.router_model_id);
    void persist(nextList, simulationTier, globalCompression);
  };

  const handleCommitProvider = (draft: ProviderDraft): void => {
    const existing = providers.some((p) => p.provider_id === draft.provider_id);
    // 新增提供方升为当前连接（后续探测/勾选/档位候选与消费立即指向新
    // 端点）；编辑当前提供方保持其当前连接位并同步档位选中态；编辑非
    // 当前提供方不改变当前连接（避免「显示 A、消费 B」——引擎消费
    // providers[0]，UI 候选/档位归属 = 同一当前连接）。
    const wasCurrent = providers[0]?.provider_id === draft.provider_id;
    let effective: ProviderDraft[];
    if (existing) {
      effective = providers.map((p) => (p.provider_id === draft.provider_id ? draft : p));
    } else {
      effective = [draft, ...providers.filter((p) => p.provider_id !== draft.provider_id)];
    }
    setProviders(effective);
    if (wasCurrent || !existing) {
      setActiveProviderId(draft.provider_id);
      setRouterModelId(draft.router_model_id ?? '');
    }
    setModal(null);
    void persist(effective, simulationTier, globalCompression);
  };

  const handleAdd = (mode: 'template' | 'custom'): void => {
    setModal({ mode });
  };

  const handleEdit = (providerId: string): void => {
    const p = providers.find((x) => x.provider_id === providerId);
    if (!p) return;
    setModal({ mode: p.vendor === '__custom__' ? 'custom' : 'template', providerId });
  };

  const handleDelete = (providerId: string): void => {
    const nextList = providers.filter((p) => p.provider_id !== providerId);
    setProviders(nextList);
    // 删除当前提供方：后继第一个自动成为新当前连接（档位候选/消费随
    // 切换，providers[0] 永远 = 引擎消费的当前连接）。
    if (activeProviderId === providerId || providers[0]?.provider_id === providerId) {
      const successor = nextList[0];
      setActiveProviderId(successor?.provider_id ?? null);
      setRouterModelId(successor?.router_model_id ?? '');
      if (successor?.compression_percent) setGlobalCompression(successor.compression_percent);
    }
    void persist(nextList, simulationTier, globalCompression);
  };

  const handleSimChange = (tier: 'off' | 'light' | 'full'): void => {
    simTouchedRef.current = true;
    setSimulationTier(tier);
  };

  const editingProvider = modal?.providerId ? providers.find((p) => p.provider_id === modal.providerId) : undefined;

  const redlineTokens = useMemo(() => {
    const base = activeProvider?.context_window && activeProvider.context_window > 0 ? activeProvider.context_window : DEFAULT_CONTEXT;
    const pct = Number.isFinite(globalCompression) ? Math.min(100, Math.max(1, globalCompression ?? 80)) : 80;
    return Math.floor((base * pct) / 100);
  }, [activeProvider, globalCompression]);

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed ink-text-faint">
        填入各提供方的 API 密钥即可使用其模型。添加后可在对话输入框选择模型；router 档位在此指定。
      </p>

      <ProviderList
        providers={providers}
        activeProviderId={activeProvider?.provider_id ?? null}
        onSelect={makeCurrent}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onAddTemplate={() => handleAdd('template')}
        onAddCustom={() => handleAdd('custom')}
      />

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium tracking-wide ink-text-muted">模型档位</div>
          <Feedback phase={savePhase} okText="已保存" failText="保存失败" />
        </div>
        <p className="text-[11px] leading-relaxed ink-text-faint">
          档位分工：router 决策；agent（对话主模型）在输入框自选，协作者经指定模型。router 留空回落对话主模型。
        </p>
        <div className="space-y-3">
          <TierModelSelect
            tier="router"
            label="router"
            hint="任务拆解与路径决策；留空回落对话主模型。"
            value={routerModelId}
            models={allModels}
            onChange={(id) => syncTierModels({ router: id })}
          />
        </div>
      </div>

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
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">自动压缩阈值</div>
        <p className="text-[10px] leading-relaxed ink-text-faint">
          三档共用同一压缩阈值。触发压缩 ≈ {redlineTokens.toLocaleString()} tokens（上下文窗口 × 阈值 %）；执行时保底下限 40k。
        </p>
        <div className="flex items-center gap-3">
          <TextInput
            type="range"
            min={1}
            max={100}
            value={String(globalCompression)}
            onChange={(e) => setGlobalCompression(Number(e.target.value) || 0)}
            className="flex-1 accent-[var(--ink-accent-approval)]"
            aria-label="压缩阈值"
          />
          <span className="w-12 shrink-0 text-right text-[11px] tabular-nums ink-text-muted">{globalCompression}%</span>
        </div>
        {(activeProvider?.context_window ?? DEFAULT_CONTEXT) >= 128 * 1024 && (
          <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
            <AlertTriangle size={10} strokeWidth={1.6} aria-hidden />
            128k 以上窗口需确保模型实际支持，避免截断降级。
          </div>
        )}
      </div>

      {modal && (
        <AddProviderModal
          mode={modal.mode}
          initial={editingProvider}
          globalCompression={globalCompression}
          onCommit={handleCommitProvider}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
