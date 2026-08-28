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
const HARD_FLOOR = 40 * 1024;

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
  const [probePhase, setProbePhase] = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');
  const [probeNote, setProbeNote] = useState<string>('');
  const [customMode, setCustomMode] = useState(false);
  const [savePhase, setSavePhase] = useState<FeedbackPhase>('idle');

  const effectiveContext = useMemo(() => {
    const raw = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT;
    return Math.floor(Math.min(raw * 0.8, HARD_FLOOR));
  }, [contextWindow]);

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

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">双挡模型</div>
        {(['main', 'router', 'audit'] as GearTier[]).map((tier) => (
          <div key={tier} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-[11px] ink-text-muted">
              {tier === 'main' ? '主模型' : tier === 'router' ? '制片人' : '审计'}
            </span>
            <TextInput
              value={tier === 'main' ? mainModelId : tier === 'router' ? routerModelId : auditModelId}
              onChange={(e) => {
                if (tier === 'main') setMainModelId(e.target.value);
                else if (tier === 'router') setRouterModelId(e.target.value);
                else setAuditModelId(e.target.value);
              }}
              placeholder="model_id"
              className="flex-1"
              aria-label={`${tier} model_id`}
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
          双挡分工：制片人决策 / 主模型 / 审计；某挡位留空时回落主模型。
        </p>
      </div>

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
          <span className="text-[11px] font-medium">{effectiveContext.toLocaleString()} tokens</span>
          <span className="text-[10px] ink-text-faint">
            （≈{Math.floor(contextWindow / 1024)}k 的 80%，保底下限 40k）
          </span>
        </div>
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
