import type { ComponentType } from 'react';

import type { ProductShellChrome } from '@app/shell/productView';
import type { InkMessage } from '@/shared/session/types';
import { MessageStream } from './MessageStream';

const noop = (): void => undefined;

/**
 * message_list ui 面入口（阶段 7b）：消息流唯一渲染面（绑定 state.messages +
 * 宿主 product chrome → MessageStream props）。装配期经 pluginFaces 注册。
 */
const MessageListAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
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

export default MessageListAdapter;
