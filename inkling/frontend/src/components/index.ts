/**
 * 机制组件注册表装配（模块加载即注册）：渲染器组件白名单基线。
 *
 * 注册即白名单放行；组件全部为纯渲染（props 注入 + bindValue 消费），
 * 无领域耦合。布局树引用未注册组件 = 渲染占位拒绝。
 *
 * 三栏布局组件集：file_tree（左）· 会话面板（message_list/knowledge_row/
 * agent_input）· session_list（右）；view_header 为设置页进入视图的返回条；
 * 功能视图组件（incubator/evolution/simulation/source/admin/architecture/
 * ui_spec_editor）入口统一收进设置页。
 */

import { registerComponent } from '@/renderer/componentRegistry';
import { FileTree } from './file_tree';
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
import { SettingsForm } from './settings_form';
import { AdminConsole } from './admin_console';
import { AdminTools } from './admin_tools';
import { ArchitectureView } from './architecture_view';
import { UiSpecEditor } from './ui_spec_editor';
import { TaskPanel } from './task_panel';
import { Dashboard } from './dashboard';
import { PathDag } from './path_dag';
import { InterventionCard } from './intervention_card';
import { registerPathAssemblyRenderers } from '@/renderer/pathAssembly';
import { KnowledgeGraph } from './knowledge_graph';
import { ComponentsMarket } from './components_market';

/** 装配所有机制通用组件（幂等：注册表同名覆盖语义天然幂等）。 */
export function registerBuiltinComponents(): void {
  registerComponent('file_tree', FileTree);
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
  registerComponent('settings_form', SettingsForm);
  registerComponent('admin_console', AdminConsole);
  registerComponent('admin_tools', AdminTools);
  registerComponent('architecture_view', ArchitectureView);
  registerComponent('ui_spec_editor', UiSpecEditor);
  registerComponent('task_panel', TaskPanel);
  registerComponent('dashboard', Dashboard);
  registerComponent('path_dag', PathDag);
  registerComponent('intervention_card', InterventionCard);
  registerComponent('knowledge_graph', KnowledgeGraph);
  registerComponent('components_market', ComponentsMarket);
  registerPathAssemblyRenderers();
}
