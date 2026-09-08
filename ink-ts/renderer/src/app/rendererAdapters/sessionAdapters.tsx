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
import type { ProductShellChrome } from '@/app/shell/productView';
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

/** evolution_feed → EvolutionFeed / ledger_view → LedgerView / trajectory_view
 *  → TrajectoryView / mechanism_view → MechanismView / todo_view → TodoView：
 *  真面已随各自插件 faces/ui 同住（pluginFaces 注册），适配器删除（阶段 7b）。 */

/** canonical 会话区适配器注册表（componentRegistry 白名单放行面；已真面化的叶子
 *  由 pluginFaces.generated.ts 注册，不再在此列）。 */
export const sessionAdapterRegistry: Record<string, ComponentType<Record<string, unknown>>> = {
  message_list: MessageListAdapter,
  agent_input: AgentInputAdapter,
};
