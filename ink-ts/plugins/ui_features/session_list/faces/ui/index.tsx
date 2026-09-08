import { useState, type ComponentType } from 'react';

import type { ProductShellChrome } from '@/app/shell/productView';
import { RightRail } from './RightRail';

const noop = (): void => undefined;

/**
 * session_list ui 面入口（阶段 7b）：会话列表 + 线程分支 mini 树
 * （折叠为本地 UI 态）。装配期经 pluginFaces.generated.ts 注册；宿主
 * product chrome → RightRail props 映射。
 */
const SessionListAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
  const [collapsed, setCollapsed] = useState(false);
  return (
    <RightRail
      collapsed={collapsed}
      onToggle={() => setCollapsed((v) => !v)}
      sessions={product.sessions ?? []}
      activeSessionId={product.activeSessionId ?? ''}
      onSelectSession={product.onSelectSession ?? noop}
      onCreateSession={product.onCreateSession ?? noop}
      onRenameSession={product.onRenameSession ?? noop}
      onDeleteSession={product.onDeleteSession ?? noop}
      onBranchFromMessage={product.onBranchFromMessage ?? noop}
      branchTrees={product.branchTrees ?? {}}
      onBranchFromLeaf={product.onBranchFromLeaf ?? noop}
    />
  );
};

export default SessionListAdapter;
