import type { ComponentType } from 'react';

import type { RoundStep } from '@/shared/session/types';
import { TrajectoryView } from './TrajectoryView';

/**
 * trajectory_view ui 面入口：state.roundSteps 绑定载荷
 * （bindValue）或壳按 spec access 切片注入的 roundSteps（顶层）→ TrajectoryView
 * props 映射。装配期经 pluginFaces.generated.ts 注册。
 */
const TrajectoryViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const bound = Array.isArray(props.bindValue) ? props.bindValue : undefined;
  return <TrajectoryView steps={(bound ?? props.roundSteps ?? []) as RoundStep[]} />;
};

export default TrajectoryViewAdapter;
