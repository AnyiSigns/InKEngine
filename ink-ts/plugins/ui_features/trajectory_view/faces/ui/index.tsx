import type { ComponentType } from 'react';

import type { RoundStep } from '@/shared/session/types';
import type { ProductShellChrome } from '@app/shell/productView';
import { TrajectoryView } from './TrajectoryView';

/**
 * trajectory_view ui 面入口（阶段 7b）：state.roundSteps 绑定载荷
 * （bindValue）或宿主 product.roundSteps → TrajectoryView props 映射。
 * 装配期经 pluginFaces.generated.ts 注册。
 */
const TrajectoryViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
  const bound = Array.isArray(props.bindValue) ? props.bindValue : undefined;
  return <TrajectoryView steps={(bound ?? product.roundSteps ?? []) as RoundStep[]} />;
};

export default TrajectoryViewAdapter;
