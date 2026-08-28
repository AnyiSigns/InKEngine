/**
 * 设置页激活入口（对外固定签名：activate(): void）。
 *
 * 普通组（全部用户）：通用/模型/应用能力/连接/关于；
 * 开发者组（devOnly，开发者模式可见）：
 * - 高级（机制视图浮窗入口）/生长治理/安全信任/环境容器；
 * - 原管理台节内嵌（注册表/任务/账本/记忆/洞察/生命周期/备份/审计）；
 * - 市场/工具/OS/工作区授权/界面编辑器（wave4 归一注册，见 app/activate）。
 * 语音并入应用能力（agent 能力扩展）；语音输入在对话输入胶囊（直连 AI）。
 * 控制台不再独立成窗——重复的管理台语音/外观/关于已随合并移除。
 */

import { Activity, BookOpen, Database, Eye, Info, LifeBuoy, Lock, PlugZap, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Wrench } from 'lucide-react';

import { GeneralSection } from './sections/general_section';
import { ModelSection } from './sections/model_section';
import { CapabilitySection } from './sections/capability_section';
import { ConnectSection } from './sections/connect_section';
import { AboutSection } from './sections/about_section';
import { AdvancedSection } from './sections/advanced_section';
import { GrowthSection } from './sections/growth_section';
import { SecuritySection } from './sections/security_section';
import { EnvironmentSection } from './sections/environment_section';
import { RegistrySection } from '@/app/console/sections/RegistrySection';
import { TaskSection } from '@/app/console/sections/TaskSection';
import { LedgerSection } from '@/app/console/sections/LedgerSection';
import { BackupSection } from '@/app/console/sections/BackupSection';
import { AuditSection } from '@/app/console/sections/AuditSection';
import { LifecycleSection } from '@/app/console/sections/LifecycleSection';
import { InsightSection } from '@/app/insights/InsightSection';
import { MemoryView } from '@/app/memory/MemoryView';
import { registerSettingsSection } from './registry';

export function registerSettingsSections(): void {
  registerSettingsSection({
    key: 'general',
    label: '通用',
    icon: <Settings2 size={16} strokeWidth={1.6} aria-hidden />,
    order: 1,
    render: () => <GeneralSection />,
  });

  registerSettingsSection({
    key: 'model',
    label: '模型',
    icon: <span className="ink-icon-chip h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-lg text-[11px] font-medium">模型</span>,
    order: 2,
    render: () => <ModelSection />,
  });

  registerSettingsSection({
    key: 'capability',
    label: '应用能力',
    icon: <SlidersHorizontal size={16} strokeWidth={1.6} aria-hidden />,
    order: 3,
    render: () => <CapabilitySection />,
  });

  registerSettingsSection({
    key: 'connect',
    label: '连接',
    icon: <PlugZap size={16} strokeWidth={1.6} aria-hidden />,
    order: 4,
    render: () => <ConnectSection />,
  });

  registerSettingsSection({
    key: 'about',
    label: '关于',
    icon: <Info size={16} strokeWidth={1.6} aria-hidden />,
    order: 5,
    render: () => <AboutSection />,
  });

  registerSettingsSection({
    key: 'advanced',
    label: '高级',
    icon: <Wrench size={16} strokeWidth={1.6} aria-hidden />,
    order: 10,
    devOnly: true,
    render: () => <AdvancedSection />,
  });

  registerSettingsSection({
    key: 'growth',
    label: '生长治理',
    icon: <Sparkles size={16} strokeWidth={1.6} aria-hidden />,
    order: 11,
    devOnly: true,
    render: () => <GrowthSection />,
  });

  registerSettingsSection({
    key: 'security',
    label: '安全信任',
    icon: <ShieldCheck size={16} strokeWidth={1.6} aria-hidden />,
    order: 12,
    devOnly: true,
    render: () => <SecuritySection />,
  });

  registerSettingsSection({
    key: 'environment',
    label: '环境容器',
    icon: <span className="ink-icon-chip h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-lg text-[11px] font-medium">环境</span>,
    order: 13,
    devOnly: true,
    render: () => <EnvironmentSection />,
  });

  // ===== 原管理台节（内嵌，devOnly）=====
  registerSettingsSection({
    key: 'registry',
    label: '注册表',
    icon: <Settings2 size={16} strokeWidth={1.6} aria-hidden />,
    order: 70,
    devOnly: true,
    render: () => <RegistrySection />,
  });

  registerSettingsSection({
    key: 'tasks',
    label: '任务',
    icon: <Activity size={16} strokeWidth={1.6} aria-hidden />,
    order: 71,
    devOnly: true,
    render: () => <TaskSection />,
  });

  registerSettingsSection({
    key: 'ledger',
    label: '账本',
    icon: <BookOpen size={16} strokeWidth={1.6} aria-hidden />,
    order: 72,
    devOnly: true,
    render: () => <LedgerSection />,
  });

  registerSettingsSection({
    key: 'memory',
    label: '记忆',
    icon: <Database size={16} strokeWidth={1.6} aria-hidden />,
    order: 73,
    devOnly: true,
    render: () => <MemoryView />,
  });

  registerSettingsSection({
    key: 'insights',
    label: '洞察',
    icon: <Eye size={16} strokeWidth={1.6} aria-hidden />,
    order: 74,
    devOnly: true,
    render: () => <InsightSection />,
  });

  registerSettingsSection({
    key: 'lifecycle',
    label: '生命周期',
    icon: <LifeBuoy size={16} strokeWidth={1.6} aria-hidden />,
    order: 75,
    devOnly: true,
    render: () => <LifecycleSection />,
  });

  registerSettingsSection({
    key: 'backup',
    label: '备份',
    icon: <ShieldCheck size={16} strokeWidth={1.6} aria-hidden />,
    order: 76,
    devOnly: true,
    render: () => <BackupSection />,
  });

  registerSettingsSection({
    key: 'audit',
    label: '审计',
    icon: <Lock size={16} strokeWidth={1.6} aria-hidden />,
    order: 77,
    devOnly: true,
    render: () => <AuditSection />,
  });
}

export function activate(): void {
  registerSettingsSections();
}

