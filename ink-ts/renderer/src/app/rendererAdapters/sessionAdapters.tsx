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

/** agent_input → InputBar：真面已随插件 plugins/ui_features/agent_input/faces/ui
 *  同住（pluginFaces 注册），适配器删除（阶段 7b）。 */

/** evolution_feed → EvolutionFeed / ledger_view → LedgerView / trajectory_view
 *  → TrajectoryView / mechanism_view → MechanismView / todo_view → TodoView：
 *  真面已随各自插件 faces/ui 同住（pluginFaces 注册），适配器删除（阶段 7b）。 */

/** canonical 会话区适配器注册表（agent_input/todo_view/evolution_feed/ledger_view/
 *  trajectory_view/mechanism_view 已真面化随插件 faces/ui 同住，pluginFaces 注册；
 *  剩 message_list 待 7b 尾段迁移）。 */
export const sessionAdapterRegistry: Record<string, ComponentType<Record<string, unknown>>> = {
  message_list: MessageListAdapter,
};
