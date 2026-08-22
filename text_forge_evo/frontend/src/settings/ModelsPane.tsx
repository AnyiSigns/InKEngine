import { Boxes, Loader2, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';

import { fetchJson } from '../shared/api';
import { cn } from '../shared/cn';
import { Button } from '../shared/ui/Button';
import { Card } from '../shared/ui/Card';
import { ADAPTERS, type ModelTierConfig, type ModelsState, type TierMeta } from '../types/models';

const TIERS: TierMeta[] = [
  { key: 'main', label: '主模型', desc: '域专才 / 生成 / 模拟' },
  { key: 'router', label: '制片人决策', desc: '留空回落主模型' },
];

const EMPTY_FORM: ModelTierConfig = {
  adapter: 'openai_compat',
  base_url: '',
  model_id: '',
  api_key: '',
  temperature: 0.7,
  max_tokens: null,
  request_timeout: 120,
};

function parseNumber(value: string): number | null {
  if (value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function ModelsPane() {
  const [models, setModels] = useState<ModelsState | null>(null);
  const [editing, setEditing] = useState<keyof ModelsState | null>(null);
  const [form, setForm] = useState<ModelTierConfig>(EMPTY_FORM);
  const [testing, setTesting] = useState<keyof ModelsState | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string }>>({});

  useEffect(() => {
    void fetchJson<ModelsState>('/api/settings/models')
      .then(setModels)
      .catch((err: unknown) => {
        alert(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const startEdit = (tier: keyof ModelsState) => {
    const cfg = models?.[tier];
    setForm(cfg ? { ...cfg } : { ...EMPTY_FORM });
    setEditing(tier);
  };

  const saveEdit = async () => {
    if (!models || !editing) return;
    const next = { ...models, [editing]: { ...form } } as ModelsState;
    try {
      const saved = await fetchJson<{ models: ModelsState }>('/api/settings/models', {
        method: 'PUT',
        body: JSON.stringify({ models: next }),
      });
      setModels(saved.models);
      setEditing(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const testTier = async (tier: keyof ModelsState) => {
    setTesting(tier);
    setTestResult((prev) => ({ ...prev, [tier]: { ok: false, text: '测试中…' } }));
    try {
      const result = await fetchJson<{ ok: boolean; reply?: string; error?: string }>(
        '/api/settings/models/test',
        { method: 'POST', body: JSON.stringify({ tier }) },
      );
      setTestResult((prev) => ({
        ...prev,
        [tier]: {
          ok: result.ok,
          text: result.ok ? `连接成功：${result.reply ?? ''}` : result.error ?? '失败',
        },
      }));
    } catch (err) {
      setTestResult((prev) => ({
        ...prev,
        [tier]: { ok: false, text: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setTesting(null);
    }
  };

  if (!models) {
    return <p className="text-xs text-muted-foreground">加载模型配置…</p>;
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-2 p-5">
        <div className="flex items-center gap-2">
          <Boxes size={14} strokeWidth={1.8} className="text-muted-foreground" />
          <div>
            <div className="text-xs font-medium">模型三挡</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              各挡位使用的 LLM 配置；API Key 仅存本机（secrets.db），不入会话记录
            </div>
          </div>
        </div>
        {TIERS.map((tier) => {
          const cfg = models[tier.key];
          const isEditing = editing === tier.key;
          const result = testResult[tier.key];
          return (
            <div key={tier.key} className="space-y-2 rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium">{tier.label}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {tier.desc} ·{' '}
                    {cfg
                      ? `${cfg.adapter} / ${cfg.model_id || '未配置'}`
                      : '未配置（回落主模型）'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="xs"
                    onClick={() => void testTier(tier.key)}
                    disabled={testing !== null || !cfg}
                  >
                    {testing === tier.key ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Wifi size={10} />
                    )}
                    测试
                  </Button>
                  <Button
                    size="xs"
                    variant={isEditing ? 'primary' : 'secondary'}
                    onClick={() => (isEditing ? void saveEdit() : startEdit(tier.key))}
                  >
                    {isEditing ? '保存' : '编辑'}
                  </Button>
                </div>
              </div>
              {result && (
                <p className={cn('text-[11px]', result.ok ? 'text-foreground' : 'text-destructive')}>
                  {result.text}
                </p>
              )}
              {isEditing && (
                <div className="grid grid-cols-2 gap-2 text-[13px]">
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">适配器</span>
                    <select
                      value={form.adapter}
                      onChange={(event) => setForm({ ...form, adapter: event.target.value })}
                      className="h-8 w-full rounded-md border border-input bg-card px-2 text-[13px] focus:border-foreground focus:outline-none"
                    >
                      {ADAPTERS.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">Base URL</span>
                    <input
                      value={form.base_url}
                      onChange={(event) => setForm({ ...form, base_url: event.target.value })}
                      placeholder="https://api.deepseek.com/v1"
                      className="h-8 w-full rounded-md border border-input bg-card px-2 text-[13px] focus:border-foreground focus:outline-none"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">模型名 model_id</span>
                    <input
                      value={form.model_id}
                      onChange={(event) => setForm({ ...form, model_id: event.target.value })}
                      placeholder="deepseek-chat"
                      className="h-8 w-full rounded-md border border-input bg-card px-2 text-[13px] focus:border-foreground focus:outline-none"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">API Key（本地端点可留空）</span>
                    <input
                      type="password"
                      value={form.api_key}
                      onChange={(event) => setForm({ ...form, api_key: event.target.value })}
                      className="h-8 w-full rounded-md border border-input bg-card px-2 text-[13px] focus:border-foreground focus:outline-none"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">Temperature</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={form.temperature}
                      onChange={(event) =>
                        setForm({ ...form, temperature: parseNumber(event.target.value) ?? 0.7 })
                      }
                      className="h-8 w-full rounded-md border border-input bg-card px-2 text-[13px] focus:border-foreground focus:outline-none"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">Max Tokens（留空不限）</span>
                    <input
                      type="number"
                      min="0"
                      value={form.max_tokens ?? ''}
                      onChange={(event) =>
                        setForm({ ...form, max_tokens: parseNumber(event.target.value) })
                      }
                      className="h-8 w-full rounded-md border border-input bg-card px-2 text-[13px] focus:border-foreground focus:outline-none"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">请求超时（秒）</span>
                    <input
                      type="number"
                      min="1"
                      value={form.request_timeout}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          request_timeout: parseNumber(event.target.value) ?? 120,
                        })
                      }
                      className="h-8 w-full rounded-md border border-input bg-card px-2 text-[13px] focus:border-foreground focus:outline-none"
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
