/**
 * 产品会话区 canonical 适配器：消息流 / 输入胶囊 / 主区页签视图。
 *
 * 适配器职责：binding 载荷（bindValue）与宿主 product chrome（产品壳视图
 * 模型 + 动作面）→ 产品组件 props 映射。产品消息流唯一渲染 = MessageStream
 * （K5 归一）；事件渲染器（messageRendererRegistry）只服务 agent 产物。
 * 无宿主数据时回落可渲染空态（组件不崩），供渲染器白名单测试独立使用。
 */

import type { ComponentType } from 'react';

import { MessageStream } from '@/app/session/MessageStream';
import { InputBar } from '@/app/input/InputBar';
import { EvolutionFeed } from '@/app/session/EvolutionFeed';
import { LedgerView } from '@/app/session/LedgerView';
import { TrajectoryView } from '@/app/session/TrajectoryView';
import { TodoView } from '@/app/session/TodoView';
import { MechanismView } from '@/app/views/mechanism/MechanismView';
import type { ProductShellChrome } from '@/app/shell/productView';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { InkMessage } from '@/shared/session/types';

/** 适配器入参（DynamicComponent 注入：spec props + chromeProps + bindValue）。 */
export interface RendererAdapterProps {
  bindValue?: unknown;
  product?: ProductShellChrome | null;
  [key: string]: unknown;
}

function productOf(props: Record<string, unknown>): ProductShellChrome {
  return (props.product as ProductShellChrome | null | undefined) ?? {};
}

const noop = (): void => undefined;

/** 宿主缺省时的只读禁用后端（available:false；视图空态不崩）。 */
const disabledBackend = { available: false } as unknown as BackendAdapter;

function backendOf(product: ProductShellChrome): BackendAdapter {
  const backend = product.backend as BackendAdapter | undefined;
  return backend ?? disabledBackend;
}

/** message_list → MessageStream（绑定 state.messages；产品流唯一渲染面）。 */
const MessageListAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  const bound = Array.isArray(props.bindValue) ? (props.bindValue as InkMessage[]) : undefined;
  const entries = bound ?? product.entries ?? [];
  const streaming = product.streaming === true;
  return (
    <MessageStream
      entries={entries}
      streaming={streaming}
      roundSteps={product.roundSteps}
      pulseText={streaming ? '正在思考…' : undefined}
      pulseColor={streaming ? 'approval' : undefined}
      simulations={product.simulations}
      spawnInstances={product.spawnInstances}
      onSpawnSelect={product.onSpawnSelect ?? noop}
      selectedSpawnIndex={product.selectedSpawnIndex ?? null}
      onSpawnSendInstruction={product.onSpawnSendInstruction ?? noop}
      spawnStreaming={streaming}
      onBranchFromMessage={product.onBranchFromMessage ?? noop}
    />
  );
};

/** agent_input → InputBar（绑定 state.session 整快照；模式/流式随快照）。 */
const AgentInputAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  const bound = (props.bindValue as { streaming?: boolean; modeTier?: string } | undefined) ?? {};
  const backend = product.backend as { available?: boolean } | null | undefined;
  const streaming = product.streaming === true || bound.streaming === true;
  return (
    <InputBar
      disabled={backend?.available === true && product.authorized !== true}
      streaming={streaming}
      models={product.models}
      routePlan={product.routePlan}
      agentModelId={product.agentModelId ?? null}
      onAgentModelSelect={product.onAgentModelSelect ?? noop}
      roundCount={product.roundCount ?? 0}
      stepCount={product.stepCount ?? 0}
      onSend={(text, attachments, model) => (product.onSend ?? noop)(text, attachments, model)}
      onAbort={product.onAbort ?? noop}
      onAttachments={(assets) => (product.onAttachments ?? noop)(assets)}
      onRoutePlanPreview={product.onRoutePlanPreview ?? noop}
    />
  );
};

/** evolution_feed → EvolutionFeed（孵化/补丁链/实例图/实体目录）。 */
const EvolutionFeedAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  return (
    <EvolutionFeed
      incubation={product.incubation ?? []}
      patchChain={product.patchChain ?? []}
      backend={backendOf(product)}
      threadId={product.activeSessionId ?? ''}
    />
  );
};

/** ledger_view → LedgerView（records.ledger 只读窗口）。 */
const LedgerViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  return (
    <LedgerView
      backend={backendOf(product)}
      threadId={product.activeSessionId ?? ''}
    />
  );
};

/** trajectory_view → TrajectoryView（state.roundSteps 快照）。 */
const TrajectoryViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  const bound = Array.isArray(props.bindValue) ? props.bindValue : undefined;
  return <TrajectoryView steps={(bound ?? product.roundSteps ?? []) as import('@/shared/session/types').RoundStep[]} />;
};

/** todo_view → TodoView（rounds.todos 只读投影）。 */
const TodoViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  const backend = product.backend as BackendAdapter | undefined;
  return <TodoView backend={backend ?? null} threadId={product.activeSessionId ?? ''} />;
};

/** mechanism_view → MechanismView（机制/演化读取面归拢消费）。 */
const MechanismViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  const backend = product.backend as BackendAdapter | undefined;
  return <MechanismView backend={backend ?? null} threadId={product.activeSessionId ?? ''} />;
};

/** canonical 会话区适配器注册表（componentRegistry 白名单放行面）。 */
export const sessionAdapterRegistry: Record<string, ComponentType<Record<string, unknown>>> = {
  message_list: MessageListAdapter,
  agent_input: AgentInputAdapter,
  evolution_feed: EvolutionFeedAdapter,
  ledger_view: LedgerViewAdapter,
  trajectory_view: TrajectoryViewAdapter,
  todo_view: TodoViewAdapter,
  mechanism_view: MechanismViewAdapter,
};
