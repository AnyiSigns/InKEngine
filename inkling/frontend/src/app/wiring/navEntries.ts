/**
 * 导航条目集中登记（装配层单一口径）。
 * 机制视图（架构/推演/来源/演化）= 独立视图；市场/能力（MCP/组件/技能/工具/OS/工作区/界面）= 视图浮窗。
 * 渲染解析：键在 getRegisteredViews() → 直接渲染组件；否则视为 componentRegistry 组件键。
 */

import { Network, GitFork, History, Sprout, Server, Boxes, Sparkles, Wrench, Shield, Settings, BookOpen } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type NavGroup = 'mech' | 'market';

export interface NavEntry {
  key: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
}

export const NAV_ENTRIES: NavEntry[] = [
  { key: 'architecture', label: '架构', icon: Network, group: 'mech' },
  { key: 'simulation', label: '推演', icon: GitFork, group: 'mech' },
  { key: 'sources', label: '来源', icon: History, group: 'mech' },
  { key: 'evolution', label: '演化', icon: Sprout, group: 'mech' },
  { key: 'mcp_market', label: 'MCP 市场', icon: Server, group: 'market' },
  { key: 'component_market', label: '组件市场', icon: Boxes, group: 'market' },
  { key: 'skill_market', label: '技能市场', icon: Sparkles, group: 'market' },
  { key: 'tools_panel', label: '工具面板', icon: Wrench, group: 'market' },
  { key: 'workspace_auth', label: '工作区授权', icon: Shield, group: 'market' },
  { key: 'ui_editor_host', label: '界面编辑器', icon: Settings, group: 'market' },
  { key: 'knowledge_panel', label: '知识面板', icon: BookOpen, group: 'market' },
];
