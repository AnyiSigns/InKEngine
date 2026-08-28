/**
 * 设置「模型」节：厂商/端点/双挡模型/推理档/压缩红线/audit 徽标。
 *
 * 8 预设厂商（openai/deepseek/zhipu/moonshot/ollama/dashscope/anthropic/gemini）
 * +自定义；per-adapter 探测（失败结构化降级：main 128k/router 32k）；
 * key 掩码输入（三处剥离：仅保存不探测用壳命令 model_key_put；禁止入
 * engine.records/事件流/日志；错误不回显明文）；压缩红线联动展示；
 * audit 三挡徽标（main/router/audit）。
 */

import { useMemo, useState } from 'react';

import { AlertTriangle, Link2, RefreshCw } from 'lucide-react';

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
  vendor: string;
  baseUrl: string;
  apiKey: string;
  mainModelId: string;
  routerModelId: string;
  auditModelId: string;
  contextWindow: number;
}

const VENDORS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'moonshot', label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1' },
  { id: 'dashscope', label: 'DashScope（通义千问）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
] as const;

const DEFAULT_CONTEXT = 128 * 1024;

const TIER_META: Array<{ tier: GearTier; label: string; hint: string }> = [
  { tier: 'main', label: '主模型', hint: '正文生成与工具执行；必填。' },
  { tier: 'router', label: '制片人', hint: '任务拆解与路径决策；留空回落主模型。' },
  { tier: 'audit', label: '审计', hint: '审批点复核与裁决；留空回落主模型。' },
];

/**
 * 三档模型配置：档位各成一张卡（显示已配置 model_id / 回落状态），
 * 点击卡片弹悬浮窗设置该档 model_id——设置页只做配置，占用/上限在对话页。
 */
function TierModelBlock({
  mainModelId,
  routerModelId,
  auditModelId,
  onChange,
}: {
  mainModelId: string;
  routerModelId: string;
  auditModelId: string;
  onChange: (tier: GearTier, id: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState<GearTier | null>(null);
  const [draft, setDraft] = useState('');

  const valueOf = (tier: GearTier): string =>
    tier === 'main' ? mainModelId : tier === 'router' ? routerModelId : auditModelId;
  const configured = (tier: GearTier): boolean => valueOf(tier).trim().length > 0;

  const openEditor = (tier: GearTier): void => {
    setDraft(valueOf(tier));
    setEditing(tier);
  };

  const commit = (): void => {
    if (editing) onChange(editing, draft.trim());
    setEditing(null);
  };

  const editingMeta = editing ? TIER_META.find((t) => t.tier === editing) ?? TIER_META[0] : null;

  return (
    <div className="ink-elevated space-y-3 px-3.5 py-3">
      <div className="text-[11px] font-medium tracking-wide ink-text-muted">模型档位</div>
      <p className="text-[11px] leading-relaxed ink-text-faint">
        三档分工：制片人决策 / 主模型生成 / 审计复核；非主档留空时回落主模型。
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
              {configured(t.tier) ? valueOf(t.tier) : (t.tier === 'main' ? '必填' : '留空回落主模型')}
            </span>
            <span className="shrink-0 text-[10px] ink-text-faint">配置 →</span>
          </button>
        ))}
      </div>
      {editing && editingMeta && (
        <FloaterWindow
          title={`设置${editingMeta.label}`}
          floaterKey={`model_tier_${editing}`}
          onClose={() => setEditing(null)}
          initialRect={{ x: 120, y: 140, width: 400, height: 200 }}
        >
          <div className="flex h-full flex-col p-4">
            <Field label={`${editingMeta.label} model_id`} hint={editingMeta.hint}>
              <TextInput
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="model_id"
                aria-label={`${editing} model_id`}
              />
            </Field>
            <div className="mt-auto flex justify-end gap-2 pt-4">
              <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>取消</Button>
              <Button size="xs" variant="primary" onClick={commit} data-ui="model_tier_commit">
                确定
              </Button>
            </div>
          </div>
        </FloaterWindow>
      )}
    </div>
  );
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export function ModelSection(): JSX.Element {
  const tauri = createTauriInvoker();
  const [vendor, setVendor] = useState<string>(VENDORS[0].id);
  const [baseUrl, setBaseUrl] = useState<string>(VENDORS[0].baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [mainModelId, setMainModelId] = useState('');
  const [routerModelId, setRouterModelId] = useState('');
  const [auditModelId, setAuditModelId] = useState('');
  const [contextWindow, setContextWindow] = useState<number>(DEFAULT_CONTEXT);
  const [compressionPercent, setCompressionPercent] = useState<number>(80);
  const [probePhase, setProbePhase] = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');
  const [probeNote, setProbeNote] = useState<string>('');
  const [customMode, setCustomMode] = useState(false);
  const [savePhase, setSavePhase] = useState<FeedbackPhase>('idle');

  // 压缩红线 = 上下文窗口 × 用户所选百分比（1%~100%）；40k 只作执行侧硬下限，不参与展示
  const redlineTokens = useMemo(() => {
    const base = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT;
    const pct = Number.isFinite(compressionPercent) ? Math.min(100, Math.max(1, compressionPercent)) : 80;
    return Math.floor((base * pct) / 100);
  }, [contextWindow, compressionPercent]);

  const handleVendorChange = (next: string): void => {
    setVendor(next);
    const v = VENDORS.find((x) => x.id === next);
    if (v) {
      setBaseUrl(v.baseUrl);
    }
    setCustomMode(next === '__custom__');
  };

  const probeModels = async (): Promise<void> => {
    setProbePhase('loading');
    setProbeNote('');
    try {
      const endpoint = vendor === 'anthropic'
        ? `${baseUrl}/v1/models`
        : vendor === 'gemini'
          ? `${baseUrl}/models`
          : `${baseUrl}/models`;

      const res = await fetch(endpoint, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      if (!res.ok) throw new Error(`探测失败：${res.status} ${res.statusText}`);
      const data = (await res.json()) as { data?: Array<{ id: string; context_window?: number }> };
      const models = data.data ?? [];
      if (models.length > 0) {
        const first = models[0];
        if (first.context_window) setContextWindow(first.context_window);
        setMainModelId(first.id);
        setProbeNote(`探测到 ${models.length} 个模型，默认=${first.id}`);
      } else {
        setProbeNote('探测成功但无模型列表');
      }
      setProbePhase('success');
    } catch {
      setProbePhase('fail');
      setProbeNote(`降级：按档位缺省窗口回落（main ${Math.floor(DEFAULT_CONTEXT / 1024)}k / router ${Math.floor(32 * 1024 / 1024)}k）`);
      setContextWindow(DEFAULT_CONTEXT);
    }
  };

  const handleSave = async (): Promise<void> => {
    setSavePhase('loading');
    try {
      const payload = {
        vendor,
        base_url: baseUrl,
        api_key: apiKey,
        main_model_id: mainModelId,
        router_model_id: routerModelId,
        audit_model_id: auditModelId,
        context_window: contextWindow,
        compression_percent: compressionPercent,
      };
      if (tauri) {
        await tauri.invoke('settings_put', { section: 'model', record: payload });
      }
      setSavePhase('success');
      setTimeout(() => setSavePhase('idle'), 1200);
    } catch {
      setSavePhase('fail');
      setTimeout(() => setSavePhase('idle'), 2000);
    }
  };

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">厂商与端点</div>
        <Field label="厂商" hint="上下文发往该 URL；自定义可手动填写端点。">
          <Select value={vendor} onChange={(e) => handleVendorChange(e.target.value)} aria-label="厂商">
            {VENDORS.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
            <option value="__custom__">自定义…</option>
          </Select>
        </Field>
        {customMode ? (
          <Field label="base_url" hint="OpenAI 兼容端点。">
            <TextInput value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} aria-label="base_url" />
          </Field>
        ) : (
          <div className="flex items-center gap-2 text-[10px] ink-text-faint">
            <Link2 size={10} strokeWidth={1.6} aria-hidden />
            {baseUrl}
          </div>
        )}
        <Field label="api_key" hint="仅保存不探测；禁止入 engine.records/事件流/日志；错误不回显明文。">
          <TextInput
            type="password"
            value={maskKey(apiKey)}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            aria-label="api_key"
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="secondary" onClick={probeModels} data-ui="model_probe">
            <RefreshCw size={10} strokeWidth={1.6} /> 探测
          </Button>
          {probePhase !== 'idle' && (
            <span className={[
              'text-[10px]',
              probePhase === 'loading' ? 'ink-text-muted' : '',
              probePhase === 'success' ? 'ink-feedback-ok' : '',
              probePhase === 'fail' ? 'ink-feedback-fail' : '',
            ].join(' ')}>
              {probePhase === 'loading' && '探测中…'}
              {probePhase === 'success' && '探测成功'}
              {probePhase === 'fail' && '探测失败'}
            </span>
          )}
          {probeNote && <span className="text-[10px] ink-text-faint">{probeNote}</span>}
        </div>
      </div>

      <TierModelBlock
        mainModelId={mainModelId}
        routerModelId={routerModelId}
        auditModelId={auditModelId}
        onChange={(tier, id) => {
          if (tier === 'main') setMainModelId(id);
          else if (tier === 'router') setRouterModelId(id);
          else setAuditModelId(id);
        }}
      />

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">上下文窗口与压缩红线</div>
        <div className="flex items-center gap-3">
          <span className="w-28 shrink-0 text-[11px] ink-text-muted">上下文窗口</span>
          <TextInput
            type="number"
            value={String(contextWindow)}
            onChange={(e) => setContextWindow(Number(e.target.value) || 0)}
            className="w-28"
            aria-label="context_window"
          />
          <span className="text-[10px] ink-text-faint">tokens</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-28 shrink-0 text-[11px] ink-text-muted">压缩红线</span>
          <TextInput
            type="number"
            min={1}
            max={100}
            value={String(compressionPercent)}
            onChange={(e) => setCompressionPercent(Number(e.target.value) || 0)}
            className="w-28"
            aria-label="compression_percent"
          />
          <span className="text-[10px] ink-text-faint">%（上下文窗口比例）</span>
        </div>
        <p className="text-[10px] ink-text-faint">
          触发压缩 ≈ {redlineTokens.toLocaleString()} tokens；执行时保底下限 40k。
        </p>
        {contextWindow >= 128 * 1024 && (
          <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
            <AlertTriangle size={10} strokeWidth={1.6} aria-hidden />
            弱模型提示：128k 以上窗口需确保模型实际支持，避免截断降级。
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Feedback phase={savePhase} okText="已保存" failText="保存失败" />
        <Button size="sm" variant="primary" onClick={handleSave} data-ui="model_save">
          保存模型配置
        </Button>
      </div>
    </div>
  );
}
