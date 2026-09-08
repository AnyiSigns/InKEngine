import type { ComponentType } from 'react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import { TodoView } from './TodoView';

/**
 * todo_view ui 面入口：spec faces.ui.access store
 * ["backend","activeSessionId"]——壳装配层 accessAwareFace 按声明切片注入。
 * 宿主/后端不可用 = 组件自回空态（不崩）。
 */
const TodoViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const backend = (props.backend as BackendAdapter | undefined) ?? null;
  return <TodoView backend={backend} threadId={(props.activeSessionId as string | undefined) ?? ''} />;
};

export default TodoViewAdapter;
