import { useState, type ComponentType } from 'react';

import type { ProductShellChrome } from '@app/shell/productView';
import { LeftRail } from './LeftRail';

const noop = (): void => undefined;

/**
 * file_tree ui 面入口（阶段 7b）：工作区授权卡 + 设置入口（折叠为本地 UI 态）。
 * 装配期经 pluginFaces.generated.ts 注册；宿主 chrome → LeftRail props 映射。
 */
const FileTreeAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
  const [collapsed, setCollapsed] = useState(false);
  return (
    <LeftRail
      collapsed={collapsed}
      onToggle={() => setCollapsed((v) => !v)}
      authorized={product.authorized === true}
      workspaceRoot={product.workspaceRoot ?? null}
      onAddWorkspace={product.onAddWorkspace ?? noop}
      onOpenSettings={product.onOpenSettings ?? noop}
    />
  );
};

export default FileTreeAdapter;
