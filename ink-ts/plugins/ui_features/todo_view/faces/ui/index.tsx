import type { ComponentType } from 'react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { ProductShellChrome } from '@app/shell/productView';
import { TodoView } from './TodoView';

/**
 * todo_view ui 面入口（阶段 7b）：宿主 product chrome → TodoView props 映射。
 * 装配期经 renderer/src/app/pluginFaces.generated.ts 静态 import + 注册。
 * 宿主/后端不可用 = 组件自回空态（不崩）。
 */
const TodoViewAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
  const backend = (product.backend as BackendAdapter | undefined) ?? null;
  return <TodoView backend={backend} threadId={product.activeSessionId ?? ''} />;
};

export default TodoViewAdapter;
