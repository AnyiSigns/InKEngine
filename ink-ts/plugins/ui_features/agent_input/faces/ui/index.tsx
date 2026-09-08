import type { ComponentType } from 'react';

import type { ProductShellChrome } from '@app/shell/productView';
import { InputBar } from './InputBar';

const noop = (): void => undefined;

/**
 * agent_input ui 面入口（阶段 7b）：输入胶囊（发送/中止/附件/模型/推理档位）。
 * state.session 绑定 + 宿主 product chrome → InputBar props 映射。
 * 装配期经 pluginFaces.generated.ts 注册。
 */
const AgentInputAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
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

export default AgentInputAdapter;
