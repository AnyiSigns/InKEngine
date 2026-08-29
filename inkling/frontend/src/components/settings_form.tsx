/**
 * 设置页（双栏形态）：左轨入口 + 分区导航，右侧一屏一分区。
 *
 * 分区：应用能力 / 成长状态 / 安全信任 / 连接 / 外观 / 关于。
 * 默认分区 = 应用能力（模型挡位）；外观含主题三档 + token 试穿。
 * 表单状态 = 组件本地草稿（应用动作经 props 注入持久化面）；
 * 试穿与主题档切换即时生效、不动会话/草稿/折叠状态（独立存储面）。
 */

import { useEffect, useState } from 'react';
import {
  Check, ChevronDown, Cpu, FileText, FlaskConical, GitBranch, Info,
  KeyRound, Paintbrush, PlugZap, RotateCcw, ShieldCheck, Sparkles,
  Volume2,
} from 'lucide-react';

import type { ViewId } from '@/renderer/uiSpecTypes';
import { Button } from '@/shared/ui/Button';
import { cn } from '@/shared/cn';
import { AppCapabilitySection, DEFAULT_CAPABILITY } from './settings_sections/app_capability';
import type { CapabilityValue } from './settings_sections/app_capability';
import { GrowthSection } from '@/app/settings/sections/growth_section';
import { MaterialImportPanel } from './settings_sections/material_import';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import { DEFAULT_SECURITY, SecurityTrust } from './settings_sections/security_trust';
import type { SecurityValue, RecoveryOps as SecurityTrustRecovery } from './settings_sections/security_trust';
import { ConnectSection, DEFAULT_CONNECT } from './settings_sections/connect_section';
import { VoiceSection } from './settings_sections/voice_section';
import type { ConnectValue } from './settings_sections/connect_section';
import { AppearanceSection, DEFAULT_APPEARANCE } from './settings_sections/appearance_section';
import type { AppearanceValue } from './settings_sections/appearance_section';

interface SettingsFormProps {
  bindValue?: unknown;
  /** 分区定位（Tab 容器下只渲染对应分区；省略则双栏全量形态） */
  form?: SectionId;
  onNavigate?: (view: ViewId) => void;
  onApplySettings?: (settings: Record<string, unknown>) => void;
  /** 宿主能力档（启动时从后端装载：推演档位/推理档初值） */
  initialCapability?: Partial<CapabilityValue>;
  /** 自动审批初值（启动时从能力记录装载：已勾选清单 + 全量开关） */
  initialAutoApprove?: { tools: string[]; allReview: boolean };
  /** 已记住域名初值（启动时从能力记录装载；联网审批的域名级记忆） */
  initialRememberedDomains?: string[];
  /** 已记住域名持久化写（设置页增删 / 审批卡记住域名共用） */
  onRememberedDomainsChange?: (domains: string[]) => void;
  /** 自动审批可登记工具清单（tools_snapshot 的 auto_approvable 过滤面） */
  autoApprovableTools?: string[];
  /** 备份/恢复向导入口（安全信任节接线） */
  onOpenBackupWizard?: (mode: 'export' | 'restore') => void;
  /** 崩溃回退操作面（安全信任节接线：回上一稳定版本 / 出厂重置） */
  recovery?: SecurityTrustRecovery | null;
  /** 既有资料批量导入操作面（搬进 InKEngine 第一步） */
  materialImport?: BackendAdapter;
}

type SectionId = 'capability' | 'growth' | 'security' | 'connect' | 'voice' | 'appearance' | 'about';

const SECTION_NAV: Array<{ id: SectionId; label: string; icon: typeof Cpu; desc: string }> = [
  { id: 'capability', label: '应用能力', icon: Cpu, desc: '模型挡位 · 推理档 · 搜索 key' },
  { id: 'growth', label: '成长状态', icon: Sparkles, desc: '自学习 · 孵化 · 闸门' },
  { id: 'security', label: '安全信任', icon: ShieldCheck, desc: '权限矩阵 · 已记住域名 · 审计' },
  { id: 'connect', label: '连接', icon: PlugZap, desc: 'MCP 市场 · 挂载向导' },
  { id: 'voice', label: '语音与离线', icon: Volume2, desc: '本地语音 · 离线支持级' },
  { id: 'appearance', label: '外观', icon: Paintbrush, desc: '主题三档 · token 试穿' },
  { id: 'about', label: '关于', icon: Info, desc: '版本 · 契约清单' },
];

const ENTRY_ITEMS: Array<{ view: ViewId; label: string; icon: typeof FlaskConical; hint: string }> = [
  { view: 'evolution', label: '演化', icon: FlaskConical, hint: '孵化 · 进化工厂 · 补丁链' },
  { view: 'admin', label: '管理台', icon: KeyRound, hint: '组件/挂载/执行体注册表' },
  { view: 'architecture', label: '架构', icon: GitBranch, hint: 'agent_graph DAG · 视觉 diff' },
  { view: 'edit_ui', label: '界面树', icon: Paintbrush, hint: 'ui_spec 编辑（悬浮窗）' },
];

export function SettingsForm({
  bindValue,
  form,
  onNavigate,
  onApplySettings,
  initialCapability,
  initialAutoApprove,
  initialRememberedDomains,
  autoApprovableTools,
  onOpenBackupWizard,
  recovery,
  materialImport,
  onRememberedDomainsChange,
}: SettingsFormProps) {
  void bindValue;
  const [active, setActive] = useState<SectionId>('capability');
  const [capability, setCapability] = useState<CapabilityValue>({ ...DEFAULT_CAPABILITY, ...initialCapability });
  const [security, setSecurity] = useState<SecurityValue>({
    ...DEFAULT_SECURITY,
    ...(initialAutoApprove
      ? { autoApproveTools: initialAutoApprove.tools, autoApproveAllReview: initialAutoApprove.allReview }
      : {}),
    ...(initialRememberedDomains ? { rememberedDomains: initialRememberedDomains } : {}),
  });
  const [connect, setConnect] = useState<ConnectValue>(DEFAULT_CONNECT);
  const [appearance, setAppearance] = useState<AppearanceValue>(DEFAULT_APPEARANCE);
  const [aboutOpen, setAboutOpen] = useState(false);

  // 宿主能力档装载（启动后异步到达：合并覆盖缺省档，不覆盖用户已编辑）
  useEffect(() => {
    if (!initialCapability) return;
    setCapability((prev) => ({ ...prev, ...initialCapability }));
  }, [initialCapability]);

  const patchSection = <T,>(setter: React.Dispatch<React.SetStateAction<T>>, patch: Partial<T>): void => {
    setter((prev) => ({ ...prev, ...patch }));
  };

  const applyAll = (): void => {
    onApplySettings?.({
      capability,
      security,
      connect,
      theme: appearance.themeDraft,
    });
  };

  const activeMeta = SECTION_NAV.find((s) => s.id === active) ?? SECTION_NAV[0];
  const ActiveIcon = activeMeta.icon;

  const renderSection = (id: SectionId): React.ReactNode => {
    switch (id) {
      case 'capability':
        return <AppCapabilitySection value={capability} patch={(next) => patchSection(setCapability, next)} />;
      case 'growth':
        return (
          <>
            <GrowthSection />
            <MaterialImportPanel materialImport={materialImport} />
          </>
        );
      case 'security':
        return (
          <SecurityTrust
            value={security}
            patch={(next) => patchSection(setSecurity, next)}
            onOpenBackupWizard={onOpenBackupWizard}
            recovery={recovery}
            autoApprovableTools={autoApprovableTools ?? []}
            onRememberedDomainsChange={onRememberedDomainsChange}
          />
        );
      case 'connect':
        return <ConnectSection value={connect} patch={(next) => patchSection(setConnect, next)} />;
      case 'voice':
        return <VoiceSection />;
      case 'appearance':
        return <AppearanceSection value={appearance} patch={(next) => patchSection(setAppearance, next)} />;
      case 'about':
        return (
          <div className="space-y-2.5">
            <div className="ink-elevated space-y-2 px-3.5 py-3">
              <div className="flex items-center gap-2">
                <span className="text-[var(--ink-font-xs)] font-semibold">InKling 0.1.0</span>
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
                主题 token：bg.base / text.base / accent.approval / status.bubble.* / status.card.edge
              </div>
            )}
          </div>
        );
      default:
        return null;
    }
  };

  // Tab 容器形态：只渲染定位分区（无左导航轨），单区一屏。
  if (form) {
    const meta = SECTION_NAV.find((s) => s.id === form) ?? activeMeta;
    return (
      <div className="ink-scroll-auto min-h-0 flex-1">
        <div className="mx-auto w-full max-w-xl px-6 py-6">
          <div className="mb-6 flex items-start gap-3">
            <span className="ink-icon-chip h-9 w-9 rounded-xl">
              <ActiveIcon size={15} strokeWidth={1.6} aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-[var(--ink-font-md)] font-semibold tracking-tight">{meta.label}</h2>
              <p className="mt-0.5 text-[11px] leading-relaxed ink-text-faint">{meta.desc}</p>
            </div>
          </div>
          {renderSection(form)}
          <div className="ink-sticky-bar mt-8 -mx-6 flex items-center justify-end gap-2 px-6 py-3">
            <Button size="sm" variant="ghost" onClick={() => patchSection(setAppearance, { themeDraft: {} })}>
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
                {isActive && <span className="ink-active-bar" aria-hidden />}
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
              <h2 className="text-[var(--ink-font-md)] font-semibold tracking-tight">{activeMeta.label}</h2>
              <p className="mt-0.5 text-[11px] leading-relaxed ink-text-faint">{activeMeta.desc}</p>
            </div>
          </div>

          {renderSection(active)}

          {/* 应用条（粘性底部） */}
          <div className="ink-sticky-bar mt-8 -mx-6 flex items-center justify-end gap-2 px-6 py-3">
            <Button size="sm" variant="ghost" onClick={() => patchSection(setAppearance, { themeDraft: {} })}>
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
