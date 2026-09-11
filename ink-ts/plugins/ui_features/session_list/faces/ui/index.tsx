import { useState, type ComponentType } from 'react';

import type { SessionBranchTree } from '@/shared/backend/backendAdapter';
import type { RailSession } from '@app/shell/shellContracts';
import { RightRail } from './RightRail';

const noop = (): void => undefined;

/**
 * session_list ui 面入口：会话列表 + 线程分支 mini 树（只读展示；
 * 折叠为本地 UI 态）。spec faces.ui.access store ["sessions","activeSessionId",
 * "branchTrees"] + inject ["onSelectSession","onCreateSession","onRenameSession",
 * "onDeleteSession"]——壳装配层 accessAwareFace 按声明切片注入
 * （顶层消费，无全量 product）。branch 续跑动作已随组装链路退役（W7-B）。
 */
const SessionListAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const [collapsed, setCollapsed] = useState(false);
  const sessions = (Array.isArray(props.sessions) ? props.sessions : []) as RailSession[];
  const branchTrees = (props.branchTrees ?? {}) as Record<string, SessionBranchTree>;
  return (
    <RightRail
      collapsed={collapsed}
      onToggle={() => setCollapsed((v) => !v)}
      sessions={sessions}
      activeSessionId={(props.activeSessionId as string | undefined) ?? ''}
      onSelectSession={(props.onSelectSession as ((id: string) => void) | undefined) ?? noop}
      onCreateSession={(props.onCreateSession as (() => void) | undefined) ?? noop}
      onRenameSession={(props.onRenameSession as ((id: string, title: string) => void) | undefined) ?? noop}
      onDeleteSession={(props.onDeleteSession as ((id: string) => void) | undefined) ?? noop}
      branchTrees={branchTrees}
    />
  );
};

export default SessionListAdapter;
