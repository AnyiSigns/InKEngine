/**
 * 设置页激活入口（对外固定签名：activate(): void）。
 *
 * 全部节对所有用户开放（不再有开发者模式门控）：通用/模型/连接/关于/
 * 知识集/架构；管理台各节内嵌（注册表/任务/账本/记忆/洞察/生命周期/备份/审计）；
 * 市场/工具/OS/工作区授权/界面编辑器（wave4 归一注册，见 app/activate）。
 * 模型页承载档位/厂商/端点/推演档；连接页承载 MCP 与搜索 key；
 * 语音输入在对话输入胶囊（直连 AI），设置不展示语音状态。
 * 控制台不再独立成窗——重复的管理台语音/外观/关于已随合并移除。
 */

import { Activity, BookOpen, Database, Eye, Info, LifeBuoy, Lock, Network, PlugZap, Settings2, ShieldCheck } from 'lucide-react';

import { GeneralSection } from './sections/general_section';
import { ModelSection } from './sections/model_section';
import { ConnectSection } from './sections/connect_section';
import { AboutSection } from './sections/about_section';
import { SecuritySection } from './sections/security_section';
import { KnowledgePanel } from '@/app/knowledge/KnowledgePanel';
import { ArchitectureView } from '@/app/views/architecture/ArchitectureView';
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
    key: 'connect',
    label: '连接',
    icon: <PlugZap size={16} strokeWidth={1.6} aria-hidden />,
    order: 3,
    render: () => <ConnectSection />,
  });

  registerSettingsSection({
    key: 'about',
    label: '关于',
    icon: <Info size={16} strokeWidth={1.6} aria-hidden />,
    order: 4,
    render: () => <AboutSection />,
  });

  registerSettingsSection({
    key: 'knowledge_set',
    label: '知识集',
    icon: <BookOpen size={16} strokeWidth={1.6} aria-hidden />,
    order: 5,
    render: () => <KnowledgePanel />,
  });

  registerSettingsSection({
    key: 'architecture',
    label: '架构',
    icon: <Network size={16} strokeWidth={1.6} aria-hidden />,
    order: 6,
    render: () => <ArchitectureView />,
  });

  registerSettingsSection({
    key: 'security',
    label: '安全信任',
    icon: <ShieldCheck size={16} strokeWidth={1.6} aria-hidden />,
    order: 12,
    render: () => <SecuritySection />,
  });

  // ===== 原管理台节（内嵌）=====
  registerSettingsSection({
    key: 'registry',
    label: '注册表',
    icon: <Settings2 size={16} strokeWidth={1.6} aria-hidden />,
    order: 70,
    render: () => <RegistrySection />,
  });

  registerSettingsSection({
    key: 'tasks',
    label: '任务',
    icon: <Activity size={16} strokeWidth={1.6} aria-hidden />,
    order: 71,
    render: () => <TaskSection />,
  });

  registerSettingsSection({
    key: 'ledger',
    label: '账本',
    icon: <BookOpen size={16} strokeWidth={1.6} aria-hidden />,
    order: 72,
    render: () => <LedgerSection />,
  });

  registerSettingsSection({
    key: 'memory',
    label: '记忆',
    icon: <Database size={16} strokeWidth={1.6} aria-hidden />,
    order: 73,
    render: () => <MemoryView />,
  });

  registerSettingsSection({
    key: 'insights',
    label: '洞察',
    icon: <Eye size={16} strokeWidth={1.6} aria-hidden />,
    order: 74,
    render: () => <InsightSection />,
  });

  registerSettingsSection({
    key: 'lifecycle',
    label: '生命周期',
    icon: <LifeBuoy size={16} strokeWidth={1.6} aria-hidden />,
    order: 75,
    render: () => <LifecycleSection />,
  });

  registerSettingsSection({
    key: 'backup',
    label: '备份',
    icon: <ShieldCheck size={16} strokeWidth={1.6} aria-hidden />,
    order: 76,
    render: () => <BackupSection />,
  });

  registerSettingsSection({
    key: 'audit',
    label: '审计',
    icon: <Lock size={16} strokeWidth={1.6} aria-hidden />,
    order: 77,
    render: () => <AuditSection />,
  });
}

export function activate(): void {
  registerSettingsSections();
}

