/**
 * 设置页（双栏形态）：左侧导航轨 + 右侧分区内容。
 *
 * 布局：入口（演化/推演/来源）+ 分区导航（模型/权限与审批/连接/
 * 环境与工作区/数据与记忆/外观/关于）驻左轨，主打分区一次一屏、
 * 留白从容；返回主界面按钮固定在左轨底部，应用条粘性驻内容区底部。
 *
 * 表单状态为组件本地态（设置页语义 = 本地草稿 + 应用动作经 props 注入）；
 * 主题试穿直接经白名单 applyThemeTokens 落地 CSS 变量（不持久化，
 * 「应用」由宿主接线持久化），未声明 token 拒绝并在界面上提示。
 * 外观空声明 = 出厂跟随系统（prefers-color-scheme 亮/暗），还原按钮即清除试穿。
 */

import { useEffect, useState } from 'react';
import {
  AppWindow, Check, ChevronDown, Cpu, Database, Download, Eye, FileText,
  FlaskConical, FolderOpen, GitBranch, Info, KeyRound, Paintbrush, PlugZap,
  RotateCcw, ScrollText, Upload,
} from 'lucide-react';

import { applyThemeTokens, rejectedThemeTokens, THEME_TOKEN_WHITELIST } from '@/renderer/themeTokens';
import type { GearTier } from '@/shared/session/types';
import type { ViewId } from '@/renderer/uiSpecTypes';
import { Button } from '@/shared/ui/Button';
import { Field, Select, TextInput } from '@/shared/ui/Field';
import { cn } from '@/shared/cn';

interface SettingsFormProps {
  bindValue?: unknown;
  onNavigate?: (view: ViewId) => void;
  onApplySettings?: (settings: Record<string, unknown>) => void;
}

const TIER_KEYS: GearTier[] = ['router', 'main'];
const TIER_LABELS: Record<GearTier, string> = {
  router: '制片人决策',
  main: '主模型',
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

type SectionId = 'model' | 'approval' | 'connect' | 'environment' | 'data' | 'appearance' | 'about';

const SECTION_NAV: Array<{ id: SectionId; label: string; icon: typeof Cpu; desc: string }> = [
  { id: 'model', label: '模型', icon: Cpu, desc: '双挡位配置 · fallback' },
  { id: 'approval', label: '权限与审批', icon: KeyRound, desc: '审批表 · 默认档 · 超时' },
  { id: 'connect', label: '连接', icon: PlugZap, desc: 'MCP 市场 · 手动挂载' },
  { id: 'environment', label: '环境与工作区', icon: AppWindow, desc: '环境声明 · 工作区授权' },
  { id: 'data', label: '数据与记忆', icon: Database, desc: '记忆窗口 · 知识集存取' },
  { id: 'appearance', label: '外观', icon: Paintbrush, desc: '主题 token 试穿' },
  { id: 'about', label: '关于', icon: Info, desc: '版本 · 契约清单' },
];

export function SettingsForm({ bindValue, onNavigate, onApplySettings }: SettingsFormProps) {
  void bindValue;
  const [active, setActive] = useState<SectionId>('model');
  const [gear, setGear] = useState<Record<GearTier, { modelId: string; fallback: boolean }>>({
    router: { modelId: '', fallback: true },
    main: { modelId: 'deepseek-chat', fallback: false },
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

  const activeMeta = SECTION_NAV.find((s) => s.id === active) ?? SECTION_NAV[0];
  const ActiveIcon = activeMeta.icon;

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左导航轨：入口 + 分区 */}
      <nav className="ink-rail flex w-52 shrink-0 flex-col border-r px-2 py-3 ink-border">
        <div className="space-y-0.5">
          <div className="px-2 pb-1 text-[9px] font-medium tracking-[0.14em] uppercase ink-text-faint">入口</div>
          {ENTRY_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.view}
                data-ui={`entry_${item.view}`}
                onClick={() => onNavigate?.(item.view)}
                className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left cursor-pointer hover:bg-[var(--ink-bg-elevated)]"
              >
                <span className="ink-icon-chip h-6 w-6 group-hover:bg-[var(--ink-bg-base)]">
                  <Icon size={11} strokeWidth={1.6} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[11px]">{item.label}</span>
                  <span className="block truncate text-[9px] ink-text-faint">{item.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="my-2.5 h-px bg-[var(--ink-border)]" />

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          <div className="px-2 pb-1 text-[9px] font-medium tracking-[0.14em] uppercase ink-text-faint">系统配置</div>
          {SECTION_NAV.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.id;
            return (
              <button
                key={item.id}
                data-ui={`settings_nav_${item.id}`}
                data-active={isActive}
                onClick={() => setActive(item.id)}
                className={cn(
                  'relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left cursor-pointer transition-colors',
                  isActive ? 'bg-[var(--ink-bg-elevated)]' : 'hover:bg-[var(--ink-bg-elevated)]',
                )}
              >
                {isActive && (
                  <span className="ink-active-bar" aria-hidden />
                )}
                <Icon
                  size={13}
                  strokeWidth={1.6}
                  className={cn('shrink-0', isActive ? '' : 'ink-text-faint')}
                  aria-hidden
                />
                <span className={cn('min-w-0 flex-1 truncate text-[11px]', isActive && 'font-medium')}>{item.label}</span>
                <span className="truncate text-[9px] ink-text-faint">{item.desc}</span>
              </button>
            );
          })}
        </div>

        <div className="pt-2">
          <Button
            data-ui="entry_main"
            variant="primary"
            className="w-full"
            onClick={() => onNavigate?.('main')}
          >
            返回主界面
          </Button>
        </div>
      </nav>

      {/* 右内容区：一屏一分区，留白从容 */}
      <div className="ink-scroll-auto min-w-0 flex-1">
        <div className="mx-auto w-full max-w-xl px-6 py-6">
          {/* 分区头 */}
          <div className="mb-6 flex items-start gap-3">
            <span className="ink-icon-chip h-9 w-9 rounded-xl">
              <ActiveIcon size={15} strokeWidth={1.6} aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold tracking-tight">{activeMeta.label}</h2>
              <p className="mt-0.5 text-[11px] leading-relaxed ink-text-faint">{activeMeta.desc}</p>
            </div>
          </div>

          {active === 'model' && (
            <div className="space-y-2.5">
              {TIER_KEYS.map((tier) => (
                <div key={tier} className="ink-elevated flex items-center gap-3 px-3.5 py-2.5">
                  <span className="w-24 shrink-0 text-[12px] font-medium">{TIER_LABELS[tier]}</span>
                  <TextInput
                    value={gear[tier].modelId}
                    placeholder="model_id"
                    aria-label={`${tier} 模型`}
                    className="flex-1"
                    onChange={(e) => setGear((prev) => ({ ...prev, [tier]: { ...prev[tier], modelId: e.target.value } }))}
                  />
                  <label className="flex shrink-0 items-center gap-1.5 pl-1 cursor-pointer" title="留空回落主模型">
                    <input
                      type="checkbox"
                      className="ink-check"
                      checked={gear[tier].fallback}
                      onChange={(e) => setGear((prev) => ({ ...prev, [tier]: { ...prev[tier], fallback: e.target.checked } }))}
                    />
                    <span className="text-[10px] ink-text-muted">fallback</span>
                  </label>
                </div>
              ))}
              <p className="pt-1 text-[10px] leading-relaxed ink-text-faint">双挡位分工：制片人决策 / 主模型；某挡位留空时回落主模型。</p>
            </div>
          )}

          {active === 'approval' && (
            <div className="space-y-4">
              <div className="space-y-1">
                <div className="text-[11px] font-medium tracking-wide ink-text-muted">审批表（kind → L0/L1/L2）</div>
                <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
                  {APPROVAL_KINDS.map((kind) => (
                    <div key={kind} className="flex items-center gap-3 px-3.5 py-2">
                      <span className="w-32 shrink-0 truncate font-mono text-[10px] ink-text-muted">{kind}</span>
                      <div className="flex gap-0.5">
                        {APPROVAL_LEVELS.map((level) => (
                          <button
                            key={level}
                            onClick={() => setApprovals((prev) => ({ ...prev, [kind]: level }))}
                            data-active={approvals[kind] === level}
                            className="ink-seg-item"
                          >
                            {level}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="ink-elevated space-y-3 px-3.5 py-3">
                <div className="flex items-center gap-3">
                  <span className="w-32 shrink-0 text-[11px] ink-text-muted">默认权限档</span>
                  <div className="ink-seg">
                    {DEFAULT_PERMISSIONS.map((permission) => (
                      <button
                        key={permission}
                        onClick={() => setDefaultPermission(permission)}
                        data-active={defaultPermission === permission}
                        className="ink-seg-item"
                      >
                        {permission}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-32 shrink-0 text-[11px] ink-text-muted">审批超时</span>
                  <TextInput
                    className="w-24"
                    value={timeoutSecs}
                    onChange={(e) => setTimeoutSecs(e.target.value)}
                    aria-label="审批超时秒数"
                  />
                  <span className="text-[10px] ink-text-faint">秒 · fail-closed</span>
                </div>
              </div>
            </div>
          )}

          {active === 'connect' && (
            <div className="space-y-2.5">
              <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
                {MCP_MARKET.map((entry) => {
                  const mounted = mcpMounted.includes(entry.name);
                  return (
                    <div key={entry.name} className="flex items-center gap-3 px-3.5 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] font-medium">{entry.name}</span>
                          <span className="ink-chip font-mono text-[9px] ink-text-faint">{entry.risk}</span>
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[9px] ink-text-faint">{entry.endpoint}</span>
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
              </div>
              <div className="flex items-center gap-2">
                <TextInput
                  value={manualMcp}
                  placeholder="手动添加：npx -y <pkg> 或 http(s)://<endpoint>"
                  onChange={(e) => setManualMcp(e.target.value)}
                  aria-label="手动添加 MCP"
                />
                <Button
                  size="md"
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
              <p className="text-[10px] leading-relaxed ink-text-faint">mcp_market 市场（出厂零预挂，一键挂载走 vetting → 观察 → L2 审批转正）</p>
              {mcpMounted.length > 0 && (
                <div className="ink-chip ink-text-muted">
                  <Check size={9} strokeWidth={2} aria-hidden />
                  已挂载：{mcpMounted.join('、')}（可回退）
                </div>
              )}
            </div>
          )}

          {active === 'environment' && (
            <div className="space-y-4">
              <div className="space-y-1">
                <div className="text-[11px] font-medium tracking-wide ink-text-muted">环境声明</div>
                <div className="flex flex-wrap gap-1.5">
                  {ENVIRONMENTS.map((env) => (
                    <span key={env} className="ink-chip font-mono ink-text-muted">{env}</span>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-[11px] font-medium tracking-wide ink-text-muted">工作区授权（桌面目录挂载点）</div>
                <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
                  {workspaceMounts.map((mount, index) => (
                    <div key={`${mount}-${index}`} className="flex items-center gap-2 px-3.5 py-2">
                      <FolderOpen size={12} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{mount}</span>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setWorkspaceMounts((prev) => prev.filter((_, i) => i !== index))}
                      >
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
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
                  <Select value={fileOpsLevel} onChange={(e) => setFileOpsLevel(e.target.value as 'allow' | 'review')} className="w-24">
                    <option value="allow">allow</option>
                    <option value="review">review</option>
                  </Select>
                  <span className="text-[10px] ink-text-faint">file_ops</span>
                </div>
              </div>
            </div>
          )}

          {active === 'data' && (
            <div className="space-y-4">
              <Field label="记忆失效窗口（天）" hint="过去 N 天内的记忆条目参与召回检索，过期条目降权。">
                <TextInput
                  className="w-28"
                  value={memoryWindow}
                  onChange={(e) => setMemoryWindow(e.target.value)}
                  aria-label="记忆失效窗口"
                />
              </Field>
              <div className="space-y-1">
                <div className="text-[11px] font-medium tracking-wide ink-text-muted">知识集存取</div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary"><Download size={11} strokeWidth={1.6} /> 导出知识集</Button>
                  <Button size="sm" variant="secondary"><Upload size={11} strokeWidth={1.6} /> 导入知识集</Button>
                  <Button size="sm" variant="ghost">清理存储</Button>
                </div>
              </div>
            </div>
          )}

          {active === 'appearance' && (
            <div className="space-y-2.5">
              <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
                {THEME_TOKEN_WHITELIST.map((token) => (
                  <div key={token} className="flex items-center gap-3 px-3.5 py-2.5">
                    <span className="w-28 shrink-0 font-mono text-[10px] ink-text-muted">{token}</span>
                    <span
                      className="h-5 w-5 shrink-0 rounded-md border border-[var(--ink-border-strong)] ink-shadow-soft"
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
              </div>
              <p className="flex items-center gap-1.5 text-[10px] leading-relaxed ink-text-faint">
                <Eye size={10} strokeWidth={1.6} className="shrink-0" aria-hidden />
                试穿即时生效（白名单内）；留空 = 跟随系统；「应用设置」持久化
              </p>
            </div>
          )}

          {active === 'about' && (
            <div className="space-y-2.5">
              <div className="ink-elevated space-y-2 px-3.5 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold">InKling 0.1.0</span>
                  <span className="ink-chip ink-text-faint">自进化认知伙伴</span>
                </div>
                <div className="text-[10px] leading-relaxed ink-text-muted">engine_version_compat：按当前 ink_engine 锁定</div>
                <div className="text-[10px] leading-relaxed ink-text-faint">契约：inkling_exec（执行件）· inkling_shell（宿主件）· 渲染组件白名单 · 事件类型清单 · 工具清单</div>
              </div>
              <button
                onClick={() => setAboutOpen((v) => !v)}
                className="flex items-center gap-1 ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent border-none text-[10px]"
              >
                <ChevronDown size={10} strokeWidth={1.6} className={cn('transition-transform', aboutOpen && 'rotate-180')} aria-hidden />
                白名单详情
              </button>
              {aboutOpen && (
                <div className="ink-feed ink-panel px-3 py-2.5 font-mono text-[9px] ink-text-faint">
                  <FileText size={9} strokeWidth={1.6} className="mr-1 inline" aria-hidden />
                  主题 token：bg.base / text.base / accent.approval
                </div>
              )}
            </div>
          )}

          {/* 应用条（粘性底部） */}
          <div className="ink-sticky-bar mt-8 -mx-6 flex items-center justify-end gap-2 px-6 py-3">
            <Button size="sm" variant="ghost" onClick={() => setThemeDraft({})}>
              <RotateCcw size={11} strokeWidth={1.6} /> 还原跟随系统
            </Button>
            <Button size="sm" variant="primary" onClick={applyAll} data-ui="btn_apply_settings">
              <Check size={11} strokeWidth={1.8} /> 应用设置
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
