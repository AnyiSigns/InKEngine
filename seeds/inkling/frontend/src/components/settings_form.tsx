/**
 * 设置页（三栏布局的其它入口统一收进本页）：入口导航 + 系统配置。
 *
 * 区块：
 * 入口（演化/推演/来源/返回主界面）/
 * 模型 / 权限与审批 / 连接（MCP 挂载管理 + 环境管理 + 工作区授权）/
 * 数据与记忆 / 外观（主题 token 试穿再应用，白名单内，空 = 跟随系统）/ 关于。
 *
 * 表单状态为组件本地态（设置页语义 = 本地草稿 + 应用动作经 props 注入）；
 * 主题试穿直接经白名单 applyThemeTokens 落地 CSS 变量（不持久化，
 * 「应用」由宿主接线持久化），未声明 token 拒绝并在界面上提示。
 * 外观空声明 = 出厂跟随系统（prefers-color-scheme 亮/暗），还原按钮即清除试穿。
 */

import { useEffect, useState } from 'react';
import {
  AppWindow, Boxes, Check, ChevronDown, Database, Download, Eye, FolderOpen,
  FlaskConical, GitBranch, Info, KeyRound, Paintbrush, PlugZap, RotateCcw, ScrollText, Upload,
} from 'lucide-react';

import { applyThemeTokens, rejectedThemeTokens, THEME_TOKEN_WHITELIST } from '@/renderer/themeTokens';
import type { GearTier } from '@/shared/session/types';
import type { ViewId } from '@/renderer/uiSpecTypes';
import { Button } from '@/shared/ui/Button';
import { Card } from '@/shared/ui/Card';
import { Field, Select, TextInput } from '@/shared/ui/Field';
import { cn } from '@/shared/cn';

interface SettingsFormProps {
  bindValue?: unknown;
  onApplySettings?: (settings: Record<string, unknown>) => void;
}

const TIER_KEYS: GearTier[] = ['router', 'tool', 'main', 'audit'];
const TIER_LABELS: Record<GearTier, string> = {
  router: '制片人决策',
  tool: '工具挡',
  main: '主模型',
  audit: '质量校验',
};

const APPROVAL_LEVELS = ['L0', 'L1', 'L2'] as const;
const APPROVAL_KINDS = ['rule', 'knowledge', 'tool', 'harness', 'theme', 'event_type', 'environment', 'artifact'] as const;
const DEFAULT_PERMISSIONS = ['allow', 'review', 'deny'] as const;

const ENVIRONMENTS = ['local', 'web_bridge', 'container'] as const;

interface McpEntry {
  name: string;
  source: string;
  endpoint: string;
  credential: 'none' | 'required';
  risk: 'low' | 'medium' | 'high';
  mounted: boolean;
}

const MCP_MARKET: McpEntry[] = [
  { name: 'web_search', source: 'market', endpoint: 'stdio: npx -y @inkling/web-search', credential: 'none', risk: 'low', mounted: false },
  { name: 'web_crawl', source: 'market', endpoint: 'stdio: npx -y @inkling/web-crawl', credential: 'none', risk: 'medium', mounted: false },
  { name: 'file_system', source: 'market', endpoint: 'stdio: npx -y @inkling/fs-server', credential: 'none', risk: 'high', mounted: false },
];

const ENTRY_ITEMS: Array<{ view: ViewId; label: string; icon: typeof FlaskConical; hint: string }> = [
  { view: 'evolution', label: '演化', icon: FlaskConical, hint: '孵化 · 进化工厂 · 补丁链' },
  { view: 'simulation', label: '推演', icon: GitBranch, hint: 'simulate_decision 分支对比' },
  { view: 'source', label: '来源', icon: ScrollText, hint: '依据链溯源' },
];

interface SettingsFormProps {
  bindValue?: unknown;
  onNavigate?: (view: ViewId) => void;
  onApplySettings?: (settings: Record<string, unknown>) => void;
}

export function SettingsForm({ bindValue, onNavigate, onApplySettings }: SettingsFormProps) {
  void bindValue;
  const [gear, setGear] = useState<Record<GearTier, { modelId: string; fallback: boolean }>>({
    router: { modelId: '', fallback: true },
    tool: { modelId: '', fallback: true },
    main: { modelId: 'deepseek-chat', fallback: false },
    audit: { modelId: '', fallback: true },
  });
  const [defaultPermission, setDefaultPermission] = useState<(typeof DEFAULT_PERMISSIONS)[number]>('review');
  const [approvals, setApprovals] = useState<Record<string, (typeof APPROVAL_LEVELS)[number]>>({
    rule: 'L1',
    knowledge: 'L2',
    tool: 'L2',
    harness: 'L2',
    theme: 'L0',
    event_type: 'L2',
    environment: 'L2',
    artifact: 'L2',
  });
  const [timeoutSecs, setTimeoutSecs] = useState('30');
  const [mcpMounted, setMcpMounted] = useState<string[]>([]);
  const [manualMcp, setManualMcp] = useState('');
  const [workspaceMounts, setWorkspaceMounts] = useState<string[]>(['~/Documents/InklingWorkspace']);
  const [fileOpsLevel, setFileOpsLevel] = useState<'allow' | 'review'>('review');
  const [memoryWindow, setMemoryWindow] = useState('30');
  // 外观：空声明 = 出厂跟随系统（prefers-color-scheme 亮/暗）；试穿经 applyThemeTokens 覆盖
  const [themeDraft, setThemeDraft] = useState<Record<string, string>>({});
  const [aboutOpen, setAboutOpen] = useState(false);

  // 皮肤试穿：白名单 token 落地 CSS 变量（未声明 token 拒绝并提示）
  useEffect(() => {
    const rejected = rejectedThemeTokens(themeDraft);
    if (rejected.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[inkling:warn] [settings] 主题 token 拒绝：${rejected.join(', ')}`);
    }
    return applyThemeTokens(themeDraft);
  }, [themeDraft]);

  const updateThemeToken = (token: string, value: string) => {
    if (!(THEME_TOKEN_WHITELIST as readonly string[]).includes(token)) return;
    setThemeDraft((prev) => ({ ...prev, [token]: value }));
  };

  const applyAll = () => {
    onApplySettings?.({
      tiers: gear,
      approvalTable: approvals,
      defaultPermission,
      timeoutSecs,
      mcpMounted,
      workspaceMounts,
      fileOpsLevel,
      memoryWindowDays: Number(memoryWindow),
      theme: themeDraft,
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 p-5">
        <SettingsSection icon={Boxes} title="入口" hint="三栏布局下其它功能统一经设置页进入">
          <div className="flex flex-wrap gap-1.5">
            {ENTRY_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.view}
                  data-ui={`entry_${item.view}`}
                  onClick={() => onNavigate?.(item.view)}
                  className="ink-btn-secondary flex items-center gap-1.5 px-3 py-2 text-[12px] cursor-pointer hover:bg-[var(--ink-bg-elevated)]"
                >
                  <Icon size={12} strokeWidth={1.6} aria-hidden />
                  {item.label}
                  <span className="text-[10px] ink-text-faint">{item.hint}</span>
                </button>
              );
            })}
            <button
              data-ui="entry_main"
              onClick={() => onNavigate?.('main')}
              className="ink-btn-primary flex items-center gap-1.5 px-3 py-2 text-[12px] cursor-pointer"
            >
              返回主界面
            </button>
          </div>
        </SettingsSection>

        <SettingsSection icon={Boxes} title="模型" hint="四挡位配置 + fallback（留空回落主模型）">
          <div className="space-y-2">
            {TIER_KEYS.map((tier) => (
              <div key={tier} className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-[12px] ink-text-muted">{TIER_LABELS[tier]}</span>
                <TextInput
                  value={gear[tier].modelId}
                  placeholder="model_id"
                  aria-label={`${tier} 模型`}
                  onChange={(e) => setGear((prev) => ({ ...prev, [tier]: { ...prev[tier], modelId: e.target.value } }))}
                />
                <label className="flex shrink-0 items-center gap-1 text-[10px] ink-text-muted">
                  <input
                    type="checkbox"
                    checked={gear[tier].fallback}
                    onChange={(e) => setGear((prev) => ({ ...prev, [tier]: { ...prev[tier], fallback: e.target.checked } }))}
                  />
                  fallback
                </label>
              </div>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection icon={KeyRound} title="权限与审批" hint="kind → L0/L1/L2 审批表 · 默认权限档 · 超时策略">
          <div className="space-y-1.5">
            {APPROVAL_KINDS.map((kind) => (
              <div key={kind} className="flex items-center gap-2">
                <span className="w-24 shrink-0 font-mono text-[10px] ink-text-muted">{kind}</span>
                <div className="flex gap-1">
                  {APPROVAL_LEVELS.map((level) => (
                    <button
                      key={level}
                      onClick={() => setApprovals((prev) => ({ ...prev, [kind]: level }))}
                      className={cn(
                        'h-6 px-2 text-[10px] cursor-pointer',
                        approvals[kind] === level ? 'ink-btn-primary' : 'ink-btn-secondary',
                      )}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <span className="w-24 shrink-0 text-[10px] ink-text-muted">默认权限档</span>
              <div className="flex gap-1">
                {DEFAULT_PERMISSIONS.map((permission) => (
                  <button
                    key={permission}
                    onClick={() => setDefaultPermission(permission)}
                    className={cn(
                      'h-6 px-2 text-[10px] cursor-pointer',
                      defaultPermission === permission ? 'ink-btn-primary' : 'ink-btn-secondary',
                    )}
                  >
                    {permission}
                  </button>
                ))}
              </div>
              <TextInput
                className="w-20"
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(e.target.value)}
                aria-label="审批超时秒数"
              />
              <span className="text-[10px] ink-text-faint">秒超时（fail-closed）</span>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection icon={PlugZap} title="连接" hint="MCP 挂载管理（市场 + 手动添加）">
          <div className="space-y-2">
            <div className="text-[10px] ink-text-faint">mcp_market 市场（出厂零预挂，一键挂载走 vetting → 观察 → L2 审批转正）</div>
            {MCP_MARKET.map((entry) => {
              const mounted = mcpMounted.includes(entry.name);
              return (
                <div key={entry.name} className="ink-elevated flex items-center gap-2 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-[11px]">{entry.name}</span>
                    <span className="ml-1.5 text-[9px] ink-text-faint">{entry.source} · {entry.risk}</span>
                  </span>
                  <Button
                    size="xs"
                    variant={mounted ? 'secondary' : 'accent'}
                    onClick={() =>
                      setMcpMounted((prev) => (mounted ? prev.filter((n) => n !== entry.name) : [...prev, entry.name]))
                    }
                  >
                    {mounted ? '已挂载' : '挂载'}
                  </Button>
                </div>
              );
            })}
            <div className="flex items-center gap-2">
              <TextInput
                value={manualMcp}
                placeholder="手动添加：npx -y <pkg> 或 http(s)://<endpoint>"
                onChange={(e) => setManualMcp(e.target.value)}
                aria-label="手动添加 MCP"
              />
              <Button
                size="sm"
                onClick={() => {
                  if (manualMcp.trim() && !mcpMounted.includes(manualMcp.trim())) {
                    setMcpMounted((prev) => [...prev, manualMcp.trim()]);
                    setManualMcp('');
                  }
                }}
              >
                添加
              </Button>
            </div>
            {mcpMounted.length > 0 && (
              <div className="text-[10px] ink-text-muted">
                已挂载：{mcpMounted.join('、')}（可回退）
              </div>
            )}
          </div>
        </SettingsSection>

        <SettingsSection icon={AppWindow} title="环境与工作区" hint="环境声明（local/web_bridge/container）+ 工作区授权 + file_ops 分级">
          <div className="flex gap-1.5">
            {ENVIRONMENTS.map((env) => (
              <span key={env} className="ink-elevated px-2 py-1 text-[10px] font-mono ink-text-muted">
                {env}
              </span>
            ))}
          </div>
          <div className="mt-2 space-y-1.5">
            {workspaceMounts.map((mount, index) => (
              <div key={`${mount}-${index}`} className="flex items-center gap-2">
                <FolderOpen size={11} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
                <span className="flex-1 truncate font-mono text-[10px]">{mount}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setWorkspaceMounts((prev) => prev.filter((_, i) => i !== index))}
                >
                  移除
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <TextInput
                placeholder="添加桌面目录挂载点（~/…）"
                aria-label="工作区挂载点"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const value = (e.target as HTMLInputElement).value.trim();
                    if (value) setWorkspaceMounts((prev) => [...prev, value]);
                    (e.target as HTMLInputElement).value = '';
                  }
                }}
              />
              <span className="text-[10px] ink-text-faint">file_ops</span>
              <Select value={fileOpsLevel} onChange={(e) => setFileOpsLevel(e.target.value as 'allow' | 'review')} className="w-24">
                <option value="allow">allow</option>
                <option value="review">review</option>
              </Select>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection icon={Database} title="数据与记忆" hint="记忆失效窗口 · 知识集导出/导入 · 存储与清理">
          <Field label="记忆失效窗口（天）">
            <TextInput
              className="w-28"
              value={memoryWindow}
              onChange={(e) => setMemoryWindow(e.target.value)}
              aria-label="记忆失效窗口"
            />
          </Field>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="secondary"><Download size={11} strokeWidth={1.6} /> 导出知识集</Button>
            <Button size="sm" variant="secondary"><Upload size={11} strokeWidth={1.6} /> 导入知识集</Button>
            <Button size="sm" variant="ghost">清理存储</Button>
          </div>
        </SettingsSection>

        <SettingsSection icon={Paintbrush} title="外观" hint="主题 token（白名单内试穿；空 = 跟随系统亮/暗）">
          <div className="space-y-2">
            {THEME_TOKEN_WHITELIST.map((token) => (
              <div key={token} className="flex items-center gap-2">
                <span className="w-28 shrink-0 font-mono text-[10px] ink-text-muted">{token}</span>
                <div
                  className="h-5 w-5 shrink-0 border"
                  style={{ background: themeDraft[token] ?? 'var(--ink-bg-surface)' }}
                  aria-hidden
                />
                <TextInput
                  value={themeDraft[token] ?? ''}
                  placeholder="跟随系统"
                  aria-label={`${token} 色值`}
                  onChange={(e) => updateThemeToken(token, e.target.value)}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setThemeDraft((prev) => {
                      const next = { ...prev };
                      delete next[token];
                      return next;
                    })
                  }
                >
                  还原跟随系统
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <Eye size={11} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
              <span className="text-[10px] ink-text-muted">试穿即时生效（白名单内）；留空 = 跟随系统；「应用设置」持久化</span>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection icon={Info} title="关于" hint="版本 / engine_version_compat / 契约清单">
          <div className="space-y-1 text-[10px] ink-text-muted">
            <div>InKling 0.1.0 · 自进化认知伙伴</div>
            <div>engine_version_compat：按当前 ink_engine 锁定</div>
            <div>契约：inkling_exec（执行件）· inkling_shell（宿主件）· 渲染组件白名单 · 事件类型清单 · 工具清单</div>
            <button
              onClick={() => setAboutOpen((v) => !v)}
              className="flex items-center gap-1 ink-text-faint hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent border-none"
            >
              <ChevronDown size={10} strokeWidth={1.6} className={cn('transition-transform', aboutOpen && 'rotate-180')} aria-hidden />
              白名单详情
            </button>
            {aboutOpen && (
              <div className="rounded-md border px-2 py-1.5 font-mono text-[9px] ink-border ink-text-faint">
                主题 token：bg.base / text.base / accent.approval
              </div>
            )}
          </div>
        </SettingsSection>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setThemeDraft({})}>
            <RotateCcw size={11} strokeWidth={1.6} /> 还原跟随系统
          </Button>
          <Button size="sm" variant="primary" onClick={applyAll} data-ui="btn_apply_settings">
            <Check size={11} strokeWidth={1.8} /> 应用设置
          </Button>
        </div>
      </div>
    </div>
  );
}

function SettingsSection({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: typeof Boxes;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-1.5">
        <Icon size={13} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold">{title}</span>
        <span className="ml-auto text-[10px] ink-text-faint">{hint}</span>
      </div>
      {children}
    </Card>
  );
}
