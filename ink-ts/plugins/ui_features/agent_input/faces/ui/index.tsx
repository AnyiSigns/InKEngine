import type { ComponentType } from 'react';

import type { ModelSelection, ModelArchiveSnapshot } from '@/shared/backend/backendAdapter';
import type { RoutePlanResult } from '@app/shell/shellContracts';
import { InputBar } from './InputBar';

const noop = (): void => undefined;

/**
 * agent_input ui 面入口：输入胶囊（发送/中止/附件/模型/推理档位）。
 * spec faces.ui.access store ["backend","authorized","streaming","models",
 * "routePlan","agentModelId","roundCount","stepCount"] + inject ["onSend",
 * "onAbort","onAttachments","onAgentModelSelect","onRoutePlanPreview"]——壳装配层
 * accessAwareFace 按声明切片注入（顶层消费，无全量 product）；state.session 绑定
 * （bindValue）仅回落 streaming。装配期经 pluginFaces.generated.ts 注册。
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
      routePlan={props.routePlan as RoutePlanResult | undefined}
      agentModelId={(props.agentModelId as string | null | undefined) ?? null}
      onAgentModelSelect={(props.onAgentModelSelect as ((id: string, pid?: string) => void) | undefined) ?? noop}
      roundCount={(props.roundCount as number | undefined) ?? 0}
      stepCount={(props.stepCount as number | undefined) ?? 0}
      onSend={(text, attachments, model) => {
        const fn = props.onSend as
          | ((t: string, a: unknown[], m?: ModelSelection) => void)
          | undefined;
        (fn ?? noop)(text, attachments, model);
      }}
      onAbort={(props.onAbort as (() => void) | undefined) ?? noop}
      onAttachments={(assets) => {
        const fn = props.onAttachments as ((a: unknown[]) => void) | undefined;
        (fn ?? noop)(assets);
      }}
      onRoutePlanPreview={(props.onRoutePlanPreview as ((t: string) => void) | undefined) ?? noop}
    />
  );
};

export default AgentInputAdapter;
