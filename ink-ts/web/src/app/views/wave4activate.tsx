/**
 * InKling 前端重做激活入口：注册市场/工具/OS/工作区视图 + 渲染器映射 + 设置节。
 *
 * 约定：对外暴露 activate() 注册函数。activate 不 import 波 2 目录，
 * 只构造符合 SettingsSectionSpec 契约的对象；条目 read/write 已下线——
 * wave4 全为 'component' 形态，装配层 normalizeWave4Sections 丢弃
 * read/write、按 key 直接渲染组件（每条 read/write 均无消费）。
 * 最终接线由 src/app/activate.tsx 组合调用。
 */

import { type ReactNode } from 'react';
import { Server, Wrench, Shield, Settings } from 'lucide-react';

import type { UISpec } from '@/renderer/uiSpecTypes';
import { registerEventRenderers } from '../renderers/eventRenderers';
import { registerComponent, type PlainComponent } from '@/renderer/componentRegistry';
import type { AppBackend } from '../backend';

import { McpMarket } from './markets/McpMarket';
import { ToolsPanel } from './tools/ToolsPanel';
import { WorkspaceAuth } from './workspace/WorkspaceAuth';
import { UiEditorHost } from './uieditor/UiEditorHost';

/** 设置条目声明形态（fe4 装配层用：组件条目经 key 渲染，承载展示字段） */
export interface SettingsItemSpec {
  key: string;
  label: string;
  hint?: string;
  kind: 'boolean' | 'select' | 'text' | 'button' | 'component';
  options?: Array<{ value: string; label: string }>;
  disabledReason?: string;
}

export interface SettingsSectionSpec {
  key: string;
  label: string;
  icon: ReactNode;
  order: number;
  items?: SettingsItemSpec[];
  render?: () => ReactNode;
}

/** 激活函数：注册所有视图/渲染器/设置节。 */
export function activate(_backend: AppBackend): { sections: SettingsSectionSpec[] } {
  registerComponent('mcp_market', McpMarket as unknown as PlainComponent);
  registerComponent('tools_panel', ToolsPanel as unknown as PlainComponent);
  registerComponent('workspace_auth', WorkspaceAuth as unknown as PlainComponent);
  registerComponent('ui_editor_host', UiEditorHost as unknown as PlainComponent);

  registerEventRenderers();

  const sections: SettingsSectionSpec[] = [
    {
      key: 'markets',
      label: '市场',
      icon: <Server size={14} strokeWidth={1.5} />,
      order: 10,
      items: [
        {
          key: 'mcp_market',
          label: 'MCP 市场',
          hint: '浏览并挂载 MCP 服务（seed 单源；stdio 挂载前确认 command）',
          kind: 'component',
        },
      ],
    },
    {
      key: 'tools',
      label: '工具',
      icon: <Wrench size={14} strokeWidth={1.5} />,
      order: 20,
      items: [
        {
          key: 'tools_panel',
          label: '工具',
          hint: '常驻必带工具集 + 全量工具视图（tools.full 真实数据）',
          kind: 'component',
        },
      ],
    },
    {
      key: 'workspace',
      label: '工作区授权',
      icon: <Shield size={14} strokeWidth={1.5} />,
      order: 40,
      items: [
        {
          key: 'workspace_auth',
          label: '授权目录',
          hint: 'workspace.state / workspace.set / workspace.revoke',
          kind: 'component',
        },
      ],
    },
    {
      key: 'ui_editor',
      label: '界面编辑器',
      icon: <Settings size={14} strokeWidth={1.5} />,
      order: 50,
      items: [
        {
          key: 'ui_editor_host',
          label: '界面树编辑器',
          hint: '界面描述开发模式（ui_spec 命令面待 W2 接线，生产入口开发模式标注）',
          kind: 'component',
          disabledReason: '界面描述开发模式',
        },
      ],
    },
  ];

  return { sections };
}

/** 激活视图组件映射（供集成 agent 使用） */
export type Wave4SettingsSection = SettingsSectionSpec;

export const viewRegistrations = {
  mcp_market: McpMarket,
  tools_panel: ToolsPanel,
  workspace_auth: WorkspaceAuth,
  ui_editor_host: UiEditorHost,
} as const;

/** ui_spec 类型导出（供测试使用） */
export type { UISpec };