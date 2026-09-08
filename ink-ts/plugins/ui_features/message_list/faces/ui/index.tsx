import type { ComponentType } from 'react';

import type { InkMessage } from '@/shared/session/types';
import { MessageStream } from './MessageStream';

const noop = (): void => undefined;

/**
 * message_list ui 面入口：消息流唯一渲染面。spec faces.ui.access
 * store/inject 声明名——壳装配层 accessAwareFace 按声明切片注入（顶层消费，
 * 无全量 product）；entries 以绑定 state.messages（bindValue）优先、声明切片
 * entries 回落；roundSteps/simulations/spawnInstances 等经 store 切片注入。
 */
const MessageListAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const bound = Array.isArray(props.bindValue) ? (props.bindValue as InkMessage[]) : undefined;
  const entries = bound ?? (Array.isArray(props.entries) ? (props.entries as InkMessage[]) : undefined) ?? [];
  const streaming = props.streaming === true;
  const roundSteps = Array.isArray(props.roundSteps) ? props.roundSteps : undefined;
  const simulations = Array.isArray(props.simulations) ? props.simulations : undefined;
  const spawnInstances = Array.isArray(props.spawnInstances) ? props.spawnInstances : undefined;
  return (
    <MessageStream
      entries={entries}
      streaming={streaming}
      roundSteps={roundSteps}
      pulseText={streaming ? '正在思考…' : undefined}
      pulseColor={streaming ? 'approval' : undefined}
      simulations={simulations}
      spawnInstances={spawnInstances}
      onSpawnSelect={(props.onSpawnSelect as ((i: number) => void) | undefined) ?? noop}
      selectedSpawnIndex={(props.selectedSpawnIndex as number | null | undefined) ?? null}
      onSpawnSendInstruction={(props.onSpawnSendInstruction as ((t: string) => void) | undefined) ?? noop}
      spawnStreaming={streaming}
      onBranchFromMessage={(props.onBranchFromMessage as ((id: string, label: string) => void) | undefined) ?? noop}
    />
  );
};

export default MessageListAdapter;
