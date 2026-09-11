/**
 * 执行树渲染组件（展示语义落地；显示设备层，纯数据驱动）。
 *
 * 数据面：execution.run 回执投影经 state.executionRuns 绑定通道注入（宿主
 * 壳落位、设备不发请求、不 import engine）。按 run_id/parent_run_id 归组
 * 为树；节点 = scope / 终态 / 成本，折叠展开逐层深看。
 * 组卡形态：并行 fan-out 组 = 协作者组卡（席位 + 归并裁决行）；
 * 组内意见块跨席位互见 = 圆桌审议卡（意见流/互见行）；形态差异只影响卡内
 * 结构，节点公共面不变。子执行失败/降级 → 前台摘要块 + 点入复盘（展开链
 * 开至该子执行卡）。
 *
 * 文案经 useT（execution.* / message.*）；色值只走语义 token 类（ink-*）。
 * 注册入口 registerExecutionTreeRenderers()：'execution_tree_card' 进动态
 * 组件注册表（运行时装配名，注册表超集允许）。
 */

import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { CircleAlert, MessagesSquare, Network } from 'lucide-react';

import type { ExecutionCost, ExecutionEvent, ExecutionReceipt } from '@/shared/session/executionTypes';
import { finalProductText } from '@/shared/session/executionTypes';
import {
  buildExecutionViewModel,
  collectIssues,
  collectSubtreeIds,
  detectGroupForm,
  findPath,
  sumSubtreeCost,
  type ExecutionCardForm,
  type ExecutionGroupInfo,
  type ExecutionIssue,
  type ExecutionTreeNode,
} from '@/shared/session/executionTree';
import { useT } from '@/i18n/useT';
import { registerComponent } from './componentRegistry';
import { statusTone } from '@/shared/ui/statusTone';

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

/** 成本紧凑投影（只显有值分量；单位走 locale）。 */
export function formatCost(cost: ExecutionCost, t: (key: string) => string): string {
  const spec = [['steps', 'execution.cost.steps'], ['cost', 'execution.cost.value'],
    ['tokens', 'execution.cost.tokens'], ['ms', 'execution.cost.ms']] as const;
  const parts: string[] = [];
  for (const [key, token] of spec) {
    const value = cost[key];
    if (typeof value === 'number' && value > 0) parts.push(interpolate(t(token), { n: value }));
  }
  return parts.join(' · ');
}

function outcomeKey(outcome: string): string {
  return (outcome === 'success' || outcome === 'failure' || outcome === 'degraded')
    ? `execution.outcome.${outcome}` : 'execution.outcome.unknown';
}

/** 形态徽标标签（组卡形态差异只影响卡内结构——头行只标形态名）。 */
function formLabel(form: ExecutionCardForm, t: (key: string) => string): string | null {
  return form === 'single' ? null : t(`execution.form.${form}`);
}

/** 组卡卡内结构（协作者组 = 席位 + 归并裁决行；圆桌审议 = 席位 + 意见互见行）。 */
function GroupBody({ group }: { group: ExecutionGroupInfo }) {
  const { t } = useT();
  if (group.form === 'single') return null;
  const isRoundtable = group.form === 'roundtable';
  const writes = group.opinions.filter((o) => o.action === 'write').length;
  const reads = group.opinions.filter((o) => o.action === 'read').length;
  return (
    <div
      className="ink-elevated rounded-lg border px-2.5 py-2"
      data-ui={isRoundtable ? 'execution_roundtable_body' : 'execution_collab_group_body'}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium ink-text-muted">
        {isRoundtable
          ? <MessagesSquare size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          : <Network size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
        <span>{isRoundtable ? t('execution.form.roundtable') : t('execution.form.collab_group')}</span>
        <span className="ml-auto ink-text-faint">{interpolate(t('execution.lanes'), { n: group.lanes })}</span>
      </div>
      <div className="space-y-0.5">
        {group.seats.map((seat) => (
          <div key={seat.run_id} className="flex items-center gap-1.5 text-[10px]" data-ui="execution_seat">
            <span className="font-mono text-[var(--ink-text-base)]">{seat.scope || '—'}</span>
            <span className={`shrink-0 ${statusTone(seat.outcome === 'success' ? 'idle' : 'error')}`}>
              {t(outcomeKey(seat.outcome))}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-[9px] ink-text-faint" data-ui="execution_group_meta">
        {group.mergeContract !== null ? (
          <span>{interpolate(t('execution.merge'), { c: group.mergeContract, a: group.adopted ?? '—' })}</span>
        ) : null}
        {isRoundtable ? <span>{interpolate(t('execution.opinions'), { w: writes, r: reads })}</span> : null}
      </div>
    </div>
  );
}

/** 树行的共享展开态（点入复盘走 forcePath 展开祖先链）。 */
export interface TreeOpenState {
  isOpen: (runId: string) => boolean;
  toggle: (runId: string) => void;
}

/** 事件带行（复盘明细面；scope · action 数据令牌直显，非文案）。 */
function EventRows({ events, margin }: { events: ExecutionEvent[]; margin: number }): ReactNode {
  return (
    <div className="text-[9px] leading-relaxed ink-text-faint" data-ui="execution_event_rows" style={{ marginLeft: margin }}>
      {events.map((event, index) => <div key={index}>{event.scope} · {event.action}</div>)}
    </div>
  );
}

/** 执行树节点行递归（scope/状态/成本 + hop 明细 + 子节点/组卡结构）。 */
function NodeRow({ node, depth, openState }: {
  node: ExecutionTreeNode;
  depth: number;
  openState: TreeOpenState;
}): ReactNode {
  const { t } = useT();
  const isOpen = openState.isOpen(node.run.run_id);
  const group = detectGroupForm(node);
  const problem = node.run.outcome === 'failure' || node.run.outcome === 'degraded';
  const expandable = node.children.length > 0 || node.run.hops.length > 0 || node.events.length > 0;
  const label = formLabel(group.form, t);
  return (
    <div data-ui="execution_run_node" data-run-id={node.run.run_id} data-depth={depth} data-open={isOpen || undefined}>
      <button
        type="button"
        onClick={() => expandable && openState.toggle(node.run.run_id)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[10px]"
        style={{ paddingLeft: depth * 12 }}
        data-ui="execution_run_toggle"
      >
        <span className="shrink-0 text-[9px] ink-text-faint" aria-hidden>{expandable ? (isOpen ? '▾' : '▸') : '·'}</span>
        <span className="shrink-0 font-mono text-[var(--ink-text-base)]">{node.run.entry_scope || node.run.run_id}</span>
        <span className={`shrink-0 ${statusTone(problem ? 'error' : 'idle')}`}>{t(outcomeKey(node.run.outcome))}</span>
        <span className="min-w-0 flex-1 truncate ink-text-faint">{formatCost(sumSubtreeCost(node), t)}</span>
        {label ? <span className="shrink-0 ink-chip py-px text-[9px]" data-ui="execution_form_chip">{label}</span> : null}
        {node.events.length > 0 ? (
          <span className="shrink-0 ink-text-faint">{interpolate(t('execution.events'), { n: node.events.length })}</span>
        ) : null}
      </button>
      {isOpen ? (
        <div className="space-y-1" data-ui="execution_run_detail">
          {node.run.hops.length > 0 ? (
            <div className="text-[9px] leading-relaxed ink-text-faint" data-ui="execution_hops" style={{ paddingLeft: (depth + 1) * 12 }}>
              {node.run.hops.map((hop, index) => (
                <div key={index}>
                  {hop.from} → {hop.shape}{typeof hop.count === 'number' ? ` ×${hop.count}` : ''} → {hop.to}
                </div>
              ))}
            </div>
          ) : null}
          {group.form !== 'single' ? (
            <div style={{ marginLeft: (depth + 1) * 12 }}><GroupBody group={group} /></div>
          ) : null}
          {node.run.error !== null ? (
            <div className="ink-accent text-[9px]" style={{ marginLeft: (depth + 1) * 12 }} data-ui="execution_run_error">
              {node.run.error}
            </div>
          ) : null}
          {node.events.length > 0 ? <EventRows events={node.events} margin={(depth + 1) * 12} /> : null}
          {node.children.map((child) => (
            <NodeRow key={child.run.run_id} node={child} depth={depth + 1} openState={openState} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 前台摘要块：失败/降级子执行行 + 汇总摘要行；点入复盘展开该卡。 */
function IssueSummary({
  issues,
  summaries,
  onReview,
}: {
  issues: ExecutionIssue[];
  summaries: string[];
  onReview: (runId: string | null) => void;
}) {
  const { t } = useT();
  if (issues.length === 0 && summaries.length === 0) return null;
  return (
    <div className="ink-accent-bg rounded-lg px-2.5 py-1.5 text-[10px]" data-ui="execution_degraded_summary">
      <div className="mb-0.5 flex items-center gap-1 font-medium">
        <CircleAlert size={10} strokeWidth={1.6} aria-hidden />
        <span>{t('execution.issues_title')}</span>
      </div>
      {issues.map((issue) => (
        <div key={issue.run.run_id} className="flex items-center gap-1.5" data-ui="execution_issue_row" data-issue-run={issue.run.run_id}>
          <span className="shrink-0 font-mono">{issue.run.entry_scope || issue.run.run_id}</span>
          <span className="min-w-0 flex-1 truncate">{t(outcomeKey(issue.run.outcome))}{issue.reason !== '' ? ` · ${issue.reason}` : ''}</span>
          <button
            type="button"
            onClick={() => onReview(issue.run.run_id)}
            className="shrink-0 cursor-pointer underline ink-text-muted"
            data-ui="execution_review_link"
          >
            {t('execution.review')}
          </button>
        </div>
      ))}
      {summaries.map((summary, index) => (
        <div key={`sum-${index}`} className="flex items-center gap-1.5" data-ui="execution_summary_row">
          <span className="min-w-0 flex-1 truncate">{summary}</span>
          <button
            type="button"
            onClick={() => onReview(null)}
            className="shrink-0 cursor-pointer underline ink-text-muted"
            data-ui="execution_review_expand_all"
          >
            {t('execution.review')}
          </button>
        </div>
      ))}
    </div>
  );
}

/** 单回执执行树卡（后台默认折叠；失败/降级摘要块折叠态仍前台可见）。 */
export function ExecutionTreeCard({ receipt }: { receipt: ExecutionReceipt }) {
  const { t } = useT();
  const vm = useMemo(() => buildExecutionViewModel(receipt), [receipt]);
  const root = vm.root;
  const issues = useMemo(() => collectIssues(root), [root]);
  const [expanded, setExpanded] = useState(false);
  const [openSet, setOpenSet] = useState<Set<string>>(() => new Set());

  const isOpen = useCallback((runId: string): boolean => openSet.has(runId), [openSet]);
  const openState = useMemo<TreeOpenState>(() => ({
    isOpen,
    toggle: (runId: string) => {
      setOpenSet((prev) => {
        const next = new Set(prev);
        if (next.has(runId)) next.delete(runId);
        else next.add(runId);
        return next;
      });
    },
  }), [isOpen]);

  // 点入复盘：展开卡与祖先链（根节点展开 = 卡展开态，子链进 openSet）
  const review = useCallback((runId: string | null) => {
    setExpanded(true);
    const path = runId === null ? null : findPath(root, runId);
    if (runId !== null && path === null) return;
    const ids = runId === null ? collectSubtreeIds(root) : path!.map((step) => step.run.run_id);
    setOpenSet(new Set(ids));
  }, [root]);

  const product = finalProductText(receipt.final_product);
  const childCount = Math.max(receipt.runs.length - 1, 0);
  const rootForm = detectGroupForm(root);
  const blockedOrFailed = receipt.blocked || receipt.outcome === 'failure';
  return (
    <section
      className="ink-status-card rounded-xl px-3 py-2"
      data-ui="execution_tree_card"
      data-run-id={receipt.run_id}
      data-expanded={expanded || undefined}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-[12px]"
        data-ui="execution_tree_header"
        aria-expanded={expanded}
      >
        <span className="shrink-0 font-medium">{t('execution.title')}</span>
        <span className="shrink-0 font-mono text-[10px] ink-text-muted" data-ui="execution_root_scope">
          {root.run.entry_scope || receipt.run_id}
        </span>
        {rootForm.form !== 'single' ? (
          <span className="shrink-0 ink-chip py-px text-[9px]">{formLabel(rootForm.form, t)}</span>
        ) : null}
        <span className={`shrink-0 text-[10px] ${statusTone(blockedOrFailed ? 'error' : receipt.outcome === 'degraded' ? 'pending' : 'idle')}`} data-ui="execution_root_outcome">
          {receipt.blocked ? t('execution.blocked') : t(outcomeKey(receipt.outcome ?? root.run.outcome))}
        </span>
        {childCount > 0 ? (
          <span className="shrink-0 text-[10px] ink-text-faint">{interpolate(t('execution.children'), { n: childCount })}</span>
        ) : null}
        <span className="ml-auto shrink-0 text-[10px] ink-text-faint">{formatCost(sumSubtreeCost(root), t)}</span>
        <span className="shrink-0 text-[10px] ink-text-muted">
          {expanded ? t('message.collapse') : t('message.expand')}
        </span>
      </button>
      {receipt.blocked && receipt.block_reason ? (
        <div className="mt-1 text-[10px] ink-accent" data-ui="execution_blocked_reason">{receipt.block_reason}</div>
      ) : null}
      {expanded ? (
        <div className="space-y-1" data-ui="execution_tree_body" data-run-id={root.run.run_id} data-open="true">
          {root.run.hops.length > 0 ? (
            <div className="text-[9px] leading-relaxed ink-text-faint" data-ui="execution_hops">
              {root.run.hops.map((hop, index) => (
                <div key={index}>
                  {hop.from} → {hop.shape}{typeof hop.count === 'number' ? ` ×${hop.count}` : ''} → {hop.to}
                </div>
              ))}
            </div>
          ) : null}
          {rootForm.form !== 'single' ? <GroupBody group={rootForm} /> : null}
          {root.run.error !== null ? (
            <div className="ink-accent text-[9px]" data-ui="execution_run_error">{root.run.error}</div>
          ) : null}
          {root.children.map((child) => (
            <NodeRow key={child.run.run_id} node={child} depth={0} openState={openState} />
          ))}
          {product !== null ? (
            <div className="text-[10px] leading-relaxed ink-text-muted" data-ui="execution_final_product">
              <span className="ink-text-faint">{t('execution.product')} · </span>{product.slice(0, 160)}
            </div>
          ) : null}
        </div>
      ) : null}
      {issues.length > 0 || receipt.degraded_summaries.length > 0 ? (
        <div className="mt-1">
          <IssueSummary issues={issues} summaries={receipt.degraded_summaries} onReview={review} />
        </div>
      ) : null}
    </section>
  );
}

/** 布局面挂接（bind state.executionRuns；产品壳装配名 execution_tree_card）。 */
export function ExecutionTreeFace(props: Record<string, unknown>): ReactNode {
  const bindValue = props.bindValue;
  const receipts = Array.isArray(bindValue) ? (bindValue as ExecutionReceipt[]) : [];
  if (receipts.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-2 px-6" data-ui="execution_tree_surface">
      {receipts.map((receipt, index) => (
        <ExecutionTreeCard key={`${receipt.run_id}:${index}`} receipt={receipt} />
      ))}
    </div>
  );
}

/** 注册入口：执行树组件进动态组件注册表（同名覆盖幂等）。 */
export function registerExecutionTreeRenderers(): void {
  registerComponent('execution_tree_card', ExecutionTreeFace);
}
