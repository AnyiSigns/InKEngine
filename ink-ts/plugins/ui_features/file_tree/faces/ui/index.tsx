import { useState, type ComponentType } from 'react';

import { LeftRail } from './LeftRail';

const noop = (): void => undefined;

/**
 * file_tree ui 面入口：工作区授权卡 + 设置入口（折叠为本地 UI 态）。
 * spec faces.ui.access store ["authorized","workspaceRoot"] + inject
 * ["onAddWorkspace","onOpenSettings"]——壳装配层 accessAwareFace 按声明切片注入
 * （顶层消费，无全量 product）。装配期经 pluginFaces.generated.ts 注册。
 */
const FileTreeAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <LeftRail
      collapsed={collapsed}
      onToggle={() => setCollapsed((v) => !v)}
      authorized={props.authorized === true}
      workspaceRoot={(props.workspaceRoot as string | null | undefined) ?? null}
      onAddWorkspace={(props.onAddWorkspace as (() => void) | undefined) ?? noop}
      onOpenSettings={(props.onOpenSettings as (() => void) | undefined) ?? noop}
    />
  );
};

export default FileTreeAdapter;
