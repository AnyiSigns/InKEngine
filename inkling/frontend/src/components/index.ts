/**
 * 机制组件注册表装配（模块加载即注册）：渲染器组件白名单基线。
 *
 * 注册即白名单放行；组件全部为纯渲染（props 注入 + bindValue 消费），
 * 无领域耦合。布局树引用未注册组件 = 渲染占位拒绝。
 *
 * 三栏布局组件集：file_tree（左）· 会话面板（message_list/knowledge_row/
 * agent_input）· session_list（右）；view_header 为设置页进入视图的返回条；
 * 功能视图组件（incubator/evolution/simulation/source/architecture/
 * ui_spec_editor）入口统一收进设置页。
 */

import { createElement } from 'react';
import { registerComponent, type PlainComponent } from '@/renderer/componentRegistry';
import { FileTree } from './file_tree';
import { SummaryBar } from './summary_bar';
import { ViewHeader } from './view_header';
import { SessionList } from './session_list';
import { MessageList } from './message_list';
import { AgentInput } from './agent_input';
import { ReviewCard } from './review_card';
import { IncubatorPanel } from './incubator_panel';
import { EvolutionFactory } from './evolution_factory';
import { EvolutionTimeline } from './evolution_timeline';
import { SimulationTree } from './simulation_tree';
import { SourceTrace } from './source_trace';
import { ArchitectureView } from './architecture_view';
import { UiSpecEditor } from './ui_spec_editor';
import { PathDag } from './path_dag';
import { registerPathAssemblyRenderers } from '@/renderer/pathAssembly';

/** 装配所有机制通用组件（幂等：注册表同名覆盖语义天然幂等）。 */
export function registerBuiltinComponents(): void {
  registerComponent('file_tree', FileTree);
  registerComponent('summary_bar', SummaryBar);
  registerComponent('view_header', ViewHeader);
  registerComponent('session_list', SessionList);
  registerComponent('message_list', MessageList);
  registerComponent('agent_input', AgentInput);
  registerComponent('review_card', ReviewCard);
  registerComponent('incubator_panel', IncubatorPanel);
  registerComponent('evolution_factory', EvolutionFactory);
  registerComponent('evolution_timeline', EvolutionTimeline);
  registerComponent('simulation_tree', SimulationTree);
  registerComponent('source_trace', SourceTrace);
  registerComponent('architecture_view', ArchitectureView);
  registerComponent('ui_spec_editor', UiSpecEditor);
  registerComponent('path_dag', PathDag);
  // 已下线出厂组件占位桩（manifest renderer_components 仍声明、随包规格
  // 仍引用：保留注册避免 spec 渲染/组件清单落回「未注册拒绝」）
  registerRetiredStub('settings_form');
  registerRetiredStub('admin_console');
  registerRetiredStub('admin_tools');
  // 白名单中尚无装配实现的事件渲染器（出厂清单保留，占位防门禁空位）
  registerRetiredStub('knowledge_row', '白名单组件（出厂清单保留）：未在装配面提供实现');
  registerRetiredStub('NodeRow', '白名单组件（出厂清单保留）：未在装配面提供实现');
  registerPathAssemblyRenderers();
}

/** 已下线/未装配组件占位：spec/清单渲染落位为显式提示，不执行任意代码。 */
function registerRetiredStub(name: string, note?: string): void {
  const Retired: PlainComponent = () =>
    createElement(
      'div',
      { className: 'border border-dashed px-3 py-2 text-[11px] ink-border ink-text-faint' },
      note ?? `组件「${name}」已下线（由设置页各节/新装配接管）`,
    );
  registerComponent(name, Retired);
}
