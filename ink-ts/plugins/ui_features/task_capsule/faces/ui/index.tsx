import type { ComponentType } from 'react';

import type { ProductShellChrome } from '@app/shell/productView';
import { TaskCapsule } from './TaskCapsule';

/**
 * task_capsule ui 面入口（阶段 7b 真面样板）：布局树组件叶子 task_capsule 的
 * 宿主 chrome → 产品组件映射。装配期由 renderer/src/app/pluginFaces.generated.ts
 * 静态 import 并 registerComponent('task_capsule', 本默认导出)。任务不在途
 * （chrome.task 缺省）= 不渲染（非任务态空）。
 */
const TaskCapsuleAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
  const task = product.task;
  if (!task) return null;
  const noop = (): void => undefined;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <TaskCapsule task={task} onCancel={product.onAbort ?? noop} onOpen={product.onOpenSettings ?? noop} />
    </div>
  );
};

export default TaskCapsuleAdapter;
