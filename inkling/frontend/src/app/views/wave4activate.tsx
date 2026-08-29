/**
 * InKling 前端重做激活入口：注册市场/工具/OS/工作区视图 + 渲染器映射 + 设置节。
 *
 * 约定：对外暴露 activate(backend) 注册函数。activate 不 import 波 2 目录，
 * 只构造符合 SettingsSectionSpec / SettingsItemSpec 契约的对象。
 * 最终接线由后继集成 agent 在 src/app/activate.tsx 中组合调用。
 */

import { type ReactNode } from 'react';
import { Server, Wrench, Shield, Settings, Boxes } from 'lucide-react';

import type { UISpec } from '@/renderer/uiSpecTypes';
import { registerEventRenderers } from '../renderers/eventRenderers';
import { registerComponent, type PlainComponent } from '@/renderer/componentRegistry';
import type { AppBackend } from '../backend';

import { McpMarket } from './markets/McpMarket';
import { ComponentRegistry } from './markets/ComponentRegistry';
import { ToolsPanel } from './tools/ToolsPanel';
import { WorkspaceAuth } from './workspace/WorkspaceAuth';
import { UiEditorHost } from './uieditor/UiEditorHost';

/** 设置节契约（波 2 registry 签名） */
export interface SettingsItemSpec {
  key: string;
  label: string;
  hint?: string;
  kind: 'boolean' | 'select' | 'text' | 'button' | 'component';
  options?: Array<{ value: string; label: string }>;
  read: () => unknown;
  write: (value: unknown) => void;
  disabledReason?: string;
  validate?: (value: unknown) => boolean;
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
export function activate(backend: AppBackend): { sections: SettingsSectionSpec[] } {
  registerComponent('mcp_market', McpMarket as unknown as PlainComponent);
  registerComponent('component_registry', ComponentRegistry as unknown as PlainComponent);
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
          hint: '浏览并挂载 MCP 服务（出厂零预挂）',
          kind: 'component',
          read: () => backend.getMcpMarket(),
          write: () => {},
        },
      ],
    },
    {
      key: 'components',
      label: '组件',
      icon: <Boxes size={14} strokeWidth={1.5} />,
      order: 15,
      items: [
        {
          key: 'component_registry',
          label: '已注册组件',
          hint: '补丁链登记的组件清单（agent 自写 / 外部拉取注册，非市场目录）',
          kind: 'component',
          read: () => backend.getComponentsManifest(),
          write: () => {},
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
          hint: '常驻必带工具集（每回合直接注入）+ 全量工具视图（含 MCP 挂载），tools_manifest 真实数据',
          kind: 'component',
          read: () => backend.getToolsManifest(),
          write: () => {},
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
          hint: 'authorization_state / workspace_authorize / workspace_revoke',
          kind: 'component',
          read: () => backend.getAuthorizationState(),
          write: () => {},
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
          hint: 'inspect_ui 拉取 setLiveSpec；产物到补丁链落链可回退',
          kind: 'component',
          read: () => backend.getUiSpec(),
          write: () => {},
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
  component_registry: ComponentRegistry,
  tools_panel: ToolsPanel,
  workspace_auth: WorkspaceAuth,
  ui_editor_host: UiEditorHost,
} as const;

/** ui_spec 类型导出（供测试使用） */
export type { UISpec };