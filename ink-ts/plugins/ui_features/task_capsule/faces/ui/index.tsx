import type { ComponentType } from 'react';

import type { TaskCapsuleData } from './types';
import { TaskCapsule } from './TaskCapsule';

/**
 * task_capsule ui 面入口：布局树组件叶子 task_capsule，
 * spec faces.ui.access store ["task"] + inject ["onAbort","onOpenSettings"]——
 * 壳装配层 accessAwareFace 按声明切片注入（顶层消费）。任务不在途
 * （task 缺省）= 不渲染（非任务态空）。
 */
const TaskCapsuleAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const task = props.task as TaskCapsuleData | null | undefined;
  if (!task) return null;
  const noop = (): void => undefined;
  const onAbort = (props.onAbort as (() => void) | undefined) ?? noop;
  const onOpenSettings = (props.onOpenSettings as (() => void) | undefined) ?? noop;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <TaskCapsule task={task} onCancel={onAbort} onOpen={onOpenSettings} />
    </div>
  );
};

export default TaskCapsuleAdapter;
