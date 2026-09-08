import type { ComponentType } from 'react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { ProductShellChrome } from '@/app/shell/productView';
import { MechanismView } from './MechanismView';

/**
 * mechanism_view ui 面入口（阶段 7b）：宿主 product chrome → MechanismView props
 * 映射。装配期经 pluginFaces.generated.ts 注册。宿主/机制未装配 = 组件空态。
 */
const MechanismViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
  const backend = (product.backend as BackendAdapter | undefined) ?? null;
  return <MechanismView backend={backend} threadId={product.activeSessionId ?? ''} />;
};

export default MechanismViewAdapter;
