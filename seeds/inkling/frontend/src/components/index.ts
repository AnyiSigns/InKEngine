/**
 * 机制组件注册表装配（模块加载即注册）：渲染器组件白名单基线。
 *
 * 注册即白名单放行；组件全部为纯渲染（props 注入 + bindValue 消费），
 * 无领域耦合。布局树引用未注册组件 = 渲染占位拒绝。
 */

import { registerComponent } from '@/renderer/componentRegistry';
import { Topbar } from './topbar';
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

/** 装配所有机制通用组件（幂等：注册表同名覆盖语义天然幂等）。 */
export function registerBuiltinComponents(): void {
  registerComponent('topbar', Topbar);
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
}
