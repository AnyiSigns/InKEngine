import type { ComponentType } from 'react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { ProductShellChrome } from '@/app/shell/productView';
import { EvolutionFeed } from './EvolutionFeed';

/** 宿主缺省只读禁用后端（available:false；演化页空态不崩）。 */
const disabledBackend = { available: false } as unknown as BackendAdapter;

/**
 * evolution_feed ui 面入口（阶段 7b）：宿主 product chrome → EvolutionFeed props
 * 映射（孵化/补丁链/最近回合实例图/协作者目录）。装配期经 pluginFaces 注册。
 */
const EvolutionFeedAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
  const backend = (product.backend as BackendAdapter | undefined) ?? disabledBackend;
  return (
    <EvolutionFeed
      incubation={product.incubation ?? []}
      patchChain={product.patchChain ?? []}
      backend={backend}
      threadId={product.activeSessionId ?? ''}
    />
  );
};

export default EvolutionFeedAdapter;
