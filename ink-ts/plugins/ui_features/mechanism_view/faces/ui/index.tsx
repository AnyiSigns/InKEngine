import type { ComponentType } from 'react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import { MechanismView } from './MechanismView';

/**
 * mechanism_view ui 面入口：spec faces.ui.access store
 * ["backend","activeSessionId"]——壳装配层 accessAwareFace 按声明切片注入
 * （backend/activeSessionId 顶层传入，无全量 product）。宿主/机制未装配 =
 * 组件空态。
 */
const MechanismViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const backend = (props.backend as BackendAdapter | undefined) ?? null;
  return <MechanismView backend={backend} threadId={(props.activeSessionId as string | undefined) ?? ''} />;
};

export default MechanismViewAdapter;
