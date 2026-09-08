/**
 * 设置页激活入口（对外固定签名：activate(): void）。
 *
 * 全部节对所有用户开放（不再有开发者模式门控）：通用/模型/连接/
 * 知识集/架构；管理台各节内嵌（记忆/洞察/审计与恢复/备份）；账本由主区
 * 「账本」页签承载（round_ledger_list 事实快照 + 摘要链）；
 * 市场/组件/工具/OS/工作区授权/界面编辑器（wave4 归一注册，见 app/activate）。
 * 模型页承载档位/厂商/端点/推演档；连接页承载 MCP 与搜索 key；
 * 语音输入在对话输入胶囊（直连 AI），设置不展示语音状态。
 * 「关于」「安全信任」节已移除：静态关于不再展示；权限矩阵（逐工具
 * allow/review/deny + 自动审批勾选）并入工具 tab（见 ToolsPanel）；
 * 出网一律走审批弹卡，已记住域名白名单机制整体废弃。
 * 控制台不再独立成窗——重复的管理台语音/外观/关于已随合并移除。
 * 注册表/任务节已移除：注册表归并到既有工具/组件/模型节，任务/定时
 * 统一走前台 sleep 工具（后台任务域废弃）。
 */

import { BookOpen, Database, Eye, FileClock, Network, PencilRuler, PlugZap, Server, Settings2, ShieldCheck, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';

import { DynamicComponent } from '@/renderer/componentRegistry';
import { registerSettingsSection } from './registry';

/** settings 段面板插件真面化（阶段 7b）：段内容 = DynamicComponent name=插件 id
 * （pluginFaces.generated.ts 静态注册）；已迁移面板在 plugins/ui_features/
 * settings_* 的 faces/ui 同住。 */
function panel(name: string) {
  return (): ReactNode => <DynamicComponent name={name} />;
}

export function registerSettingsSections(): void {
  registerSettingsSection({
    key: 'general',
    label: '通用',
    icon: <Settings2 size={16} strokeWidth={1.6} aria-hidden />,
    order: 1,
    render: panel('settings_general'),
  });

  registerSettingsSection({
    key: 'model',
    label: '模型',
    icon: <span className="ink-icon-chip h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-lg text-[11px] font-medium">模型</span>,
    order: 2,
    render: panel('settings_model'),
  });

  registerSettingsSection({
    key: 'connect',
    label: '连接',
    icon: <PlugZap size={16} strokeWidth={1.6} aria-hidden />,
    order: 3,
    render: panel('settings_connect'),
  });

  // ===== wave4 面板（阶段 7b 真面化：插件自建 AppBackend 兜底，见各插件入口）=====
  registerSettingsSection({
    key: 'mcp_market',
    label: 'MCP 市场',
    icon: <Server size={16} strokeWidth={1.6} aria-hidden />,
    order: 10,
    render: panel('mcp_market'),
  });

  registerSettingsSection({
    key: 'tools_panel',
    label: '工具',
    icon: <Wrench size={16} strokeWidth={1.6} aria-hidden />,
    order: 20,
    render: panel('tools_panel'),
  });

  registerSettingsSection({
    key: 'workspace_auth',
    label: '工作区授权',
    icon: <ShieldCheck size={16} strokeWidth={1.6} aria-hidden />,
    order: 40,
    render: panel('workspace_auth'),
  });

  registerSettingsSection({
    key: 'ui_editor',
    label: '界面编辑器',
    icon: <PencilRuler size={16} strokeWidth={1.6} aria-hidden />,
    order: 50,
    render: panel('ui_editor_host'),
  });

  registerSettingsSection({
    key: 'knowledge_set',
    label: '知识集',
    icon: <BookOpen size={16} strokeWidth={1.6} aria-hidden />,
    order: 5,
    render: panel('settings_knowledge'),
  });

  registerSettingsSection({
    key: 'architecture',
    label: '架构',
    icon: <Network size={16} strokeWidth={1.6} aria-hidden />,
    order: 6,
    render: panel('settings_architecture'),
  });

  // ===== 原管理台节（内嵌）=====
  registerSettingsSection({
    key: 'memory',
    label: '记忆',
    icon: <Database size={16} strokeWidth={1.6} aria-hidden />,
    order: 73,
    render: panel('settings_memory'),
  });

  registerSettingsSection({
    key: 'insights',
    label: '洞察',
    icon: <Eye size={16} strokeWidth={1.6} aria-hidden />,
    order: 74,
    render: panel('settings_insights'),
  });

  registerSettingsSection({
    key: 'audit_recovery',
    label: '审计与恢复',
    icon: <FileClock size={16} strokeWidth={1.6} aria-hidden />,
    order: 75,
    render: panel('settings_audit_recovery'),
  });

  registerSettingsSection({
    key: 'backup',
    label: '备份',
    icon: <ShieldCheck size={16} strokeWidth={1.6} aria-hidden />,
    order: 76,
    render: panel('settings_backup'),
  });
}

export function activate(): void {
  registerSettingsSections();
}

