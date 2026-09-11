import type { ComponentType } from 'react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import { EvolutionFeed } from './EvolutionFeed';

/** 宿主缺省只读禁用后端（available:false；演化页空态不崩）。 */
const disabledBackend = { available: false } as unknown as BackendAdapter;

/**
 * evolution_feed ui 面入口：spec faces.ui.access store
 * ["incubation","patchChain","backend"]——壳装配层
 * accessAwareFace 按声明切片注入（顶层消费，无全量 product）。装配期经
 * pluginFaces.generated.ts 注册。
 */
const EvolutionFeedAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const backend = (props.backend as BackendAdapter | undefined) ?? disabledBackend;
  const incubation = Array.isArray(props.incubation) ? props.incubation : [];
  const patchChain = Array.isArray(props.patchChain) ? props.patchChain : [];
  return (
    <EvolutionFeed
      incubation={incubation}
      patchChain={patchChain}
      backend={backend}
    />
  );
};

export default EvolutionFeedAdapter;
