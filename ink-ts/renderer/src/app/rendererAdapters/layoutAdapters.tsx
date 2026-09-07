/**
 * 产品壳布局 canonical 适配器：顶栏 / 左右栏 / 覆盖层（审批卡/设置浮层）。
 *
 * 适配器职责：宿主 product chrome（产品壳视图模型 + 动作面）→ 产品组件
 * props 映射。栏体折叠与顶栏自动隐藏属本地 UI 态（不进布局数据）；
 * 无宿主数据时回落可渲染占位（组件不崩），供渲染器白名单测试独立使用。
 */

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';

import { TopBar } from '@/app/shell/TopBar';
import { LeftRail } from '@/app/shell/LeftRail';
import { RightRail } from '@/app/shell/RightRail';
import { SettingsFloater } from '@/app/settings/settings_floater';
import { TaskCapsule } from '@/app/tasks/TaskCapsule';
import { ReviewCard, type ReviewResolution } from '@/components/review_card';
import type { ProductShellChrome } from '@/app/shell/productView';

function productOf(props: Record<string, unknown>): ProductShellChrome {
  return (props.product as ProductShellChrome | null | undefined) ?? {};
}

const noop = (): void => undefined;

/** 顶栏（悬停触发带 + 磨砂 veil；宿主数据经 product chrome 注入）。 */
const TopBarAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const show = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setOpen(true);
  };
  const hide = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 240);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <>
      <div className="ink-topbar-trigger" onMouseEnter={show} />
      <div className="ink-topbar-veil" data-open={open ? 'true' : undefined} onMouseEnter={show} onMouseLeave={hide}>
        <TopBar
          title={product.title ?? ''}
          tab={product.tab ?? 'chat'}
          onTabChange={product.onTabChange ?? noop}
          onTitleChange={product.onTitleChange ?? noop}
          hasTodo={product.hasTodo}
          todoPending={product.todoPending}
        />
      </div>
    </>
  );
};

/** file_tree → LeftRail（工作区授权卡 + 设置入口；折叠为本地 UI 态）。 */
const FileTreeAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
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

/** session_list → RightRail（会话列表 + 分支 mini 树；折叠为本地 UI 态）。 */
const SessionListAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
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

/** task_capsule：长任务期胶囊（任务在途才渲染；宿主 product.task）。 */
const TaskCapsuleAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  const task = product.task;
  if (!task) return null;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <TaskCapsule task={task} onCancel={product.onAbort ?? noop} onOpen={product.onOpenSettings ?? noop} />
    </div>
  );
};

/** review_card：审批卡覆盖层（events.review_card 绑定；决议续跑经宿主）。 */
const ReviewCardAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  const bindEvent = props.bindValue as { payload?: Record<string, unknown> } | undefined;
  return (
    <ReviewCard
      bindValue={props.bindValue}
      onResolve={(resolution: ReviewResolution, editedContent?: string) =>
        (product.onResolveReview ?? noop)(resolution, editedContent, bindEvent?.payload)
      }
    />
  );
};

/** settings_floater：设置浮层（注册式驱动；打开态 = 宿主 settingsOpen）。 */
const SettingsFloaterAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  const backend = product.backend as { available?: boolean } | undefined;
  return (
    <SettingsFloater
      open={product.settingsOpen === true}
      onClose={product.onCloseSettings ?? noop}
      backend={{ available: backend?.available === true }}
    />
  );
};

/** canonical 布局适配器注册表（componentRegistry 白名单放行面）。 */
export const layoutAdapterRegistry: Record<string, ComponentType<Record<string, unknown>>> = {
  top_bar: TopBarAdapter,
  file_tree: FileTreeAdapter,
  session_list: SessionListAdapter,
  task_capsule: TaskCapsuleAdapter,
  review_card: ReviewCardAdapter,
  settings_floater: SettingsFloaterAdapter,
};

/** 空态说明（占位适配器共用文案）。 */
export function adapterEmptyNote(text: string): ReactNode {
  return <div className="px-3 py-2 text-[11px] ink-text-faint">{text}</div>;
}
