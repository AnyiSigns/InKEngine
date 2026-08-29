import { Network, Sprout } from 'lucide-react';

import './w3.css';
import { registerView } from './registry';
import { ArchitectureView } from './architecture/ArchitectureView';
import { EvolutionView } from './evolution/EvolutionView';

/**
 * W3 机制可视化对外唯一出口：注册两视图（架构/演化）。
 * 集成 agent 经 getRegisteredViews() 取用并装配到主界面导航。
 */
export function activate(): void {
  registerView({ id: 'architecture', label: '架构', icon: Network, Component: ArchitectureView });
  registerView({ id: 'evolution', label: '演化', icon: Sprout, Component: EvolutionView });
}
