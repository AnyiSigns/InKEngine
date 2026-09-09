import type { ComponentType } from 'react';

import type { ApprovalPose, ModelSelection, ModelArchiveSnapshot } from '@/shared/backend/backendAdapter';
import { InputBar } from './InputBar';

const noop = (): void => undefined;

/**
 * onAbort 注入失败兜底：不静默装死——若宿主未把 onAbort 经
 * access faces.ui.access.inject 注入，停止按钮点击将无效且无从查起。
 * 此处显式告警便于定位（正常路径已注入，不会触发）。
 */
const abortFallback = (): void => {
  // eslint-disable-next-line no-console
  console.error('[agent_input] onAbort 未注入：停止按钮无法中止当前回合（请核对 spec faces.ui.access.inject 与宿主 product.onAbort）');
};

/**
 * agent_input ui 面入口：输入胶囊（发送/中止/附件/模型/推理档位）。
 * spec faces.ui.access store ["backend","authorized","streaming","models",
 * "agentModelId","roundCount","stepCount"] + inject ["onSend","onAbort",
 * "onAttachments","onAgentModelSelect"]——壳装配层 accessAwareFace 按声明切片
 * 注入（顶层消费，无全量 product）；state.session 绑定（bindValue）仅回落
 * streaming。装配期经 pluginFaces.generated.ts 注册。
 */
const AgentInputAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const bound = (props.bindValue as { streaming?: boolean; modeTier?: string } | undefined) ?? {};
  const backend = props.backend as { available?: boolean } | null | undefined;
  const streaming = props.streaming === true || bound.streaming === true;
  return (
    <InputBar
      disabled={backend?.available === true && props.authorized !== true}
      streaming={streaming}
      models={props.models as ModelArchiveSnapshot | undefined}
      agentModelId={(props.agentModelId as string | null | undefined) ?? null}
      approvalPose={(props.approvalPose as ApprovalPose | undefined) ?? 'review'}
      onApprovalPoseChange={(props.onApprovalPoseChange as ((pose: ApprovalPose) => void) | undefined) ?? noop}
      onAgentModelSelect={(props.onAgentModelSelect as ((id: string, pid?: string) => void) | undefined) ?? noop}
      roundCount={(props.roundCount as number | undefined) ?? 0}
      stepCount={(props.stepCount as number | undefined) ?? 0}
      onSend={(text, attachments, model) => {
        const fn = props.onSend as
          | ((t: string, a: unknown[], m?: ModelSelection) => void)
          | undefined;
        (fn ?? noop)(text, attachments, model);
      }}
      onAbort={(props.onAbort as (() => void) | undefined) ?? abortFallback}
      onAttachments={(assets) => {
        const fn = props.onAttachments as ((a: unknown[]) => void) | undefined;
        (fn ?? noop)(assets);
      }}
    />
  );
};

export default AgentInputAdapter;
