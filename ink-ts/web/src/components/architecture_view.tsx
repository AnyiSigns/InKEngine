/**
 * 架构视图：agent_graph DAG 读 + 点展示 + 视觉 diff 高亮。
 *
 * 数据 = inspect_graph 快照（nodes/edges），基线 = 上次确认快照
 * （props/graph 通道双面；差异高亮：新增 = 朱砂描边、移除 = 消退
 * 划线、变更 = 强调点，单强调色纪律——朱砂只在决策/差异点）。
 */

import { useMemo } from 'react';

import { GitBranch } from 'lucide-react';

import type { GraphSnapshot } from '@/shared/session/inspectTypes';
import { cn } from '@/shared/cn';

export interface GraphDiff {
  added: Set<string>;
  removed: Set<string>;
  changed: Set<string>;
}

export function diffGraphs(current: GraphSnapshot, baseline: GraphSnapshot | null): GraphDiff {
  const currentIds = new Set(current.nodes.map((node) => node.id));
  const baselineIds = new Set(baseline?.nodes.map((node) => node.id) ?? []);
  const added = new Set([...currentIds].filter((id) => !baselineIds.has(id)));
  const removed = new Set([...baselineIds].filter((id) => !currentIds.has(id)));
  const changed = new Set(
    [...currentIds].filter((id) => {
      if (added.has(id) || !baseline) return false;
      const before = baseline.nodes.find((node) => node.id === id);
      const after = current.nodes.find((node) => node.id === id);
      return before !== undefined && after !== undefined && (before.label !== after.label || before.type !== after.type);
    }),
  );
  return { added, removed, changed };
}

interface ArchitectureViewProps {
  bindValue?: unknown;
  /** 基线快照（上次确认；缺省 = 无差异） */
  baseline?: GraphSnapshot | null;
  /** 宿主注入的基线快照（渲染器壳接线面） */
  architectureBaseline?: unknown;
}

export function ArchitectureView({ bindValue, baseline = null, architectureBaseline }: ArchitectureViewProps) {
  const graph = bindValue as GraphSnapshot | undefined;
  const baselineSnapshot = baseline ?? (architectureBaseline as GraphSnapshot | null | undefined) ?? null;
  const diff = useMemo(() => diffGraphs(graph ?? emptyGraph(), baselineSnapshot), [graph, baselineSnapshot]);

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <span className="ink-breathe ink-icon-chip h-11 w-11 rounded-full">
          <GitBranch size={19} strokeWidth={1.4} className="ink-text-faint" aria-hidden />
        </span>
        <div className="text-[var(--ink-font-sm)] tracking-wide ink-text-faint">暂无回合图（等待 inspect_graph 快照）</div>
      </div>
    );
  }

  const nodes = graph.nodes;
  const edges = graph.edges;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[10px] ink-text-faint">
        <span className="ink-chip py-px">节点 {nodes.length}</span>
        <span className="ink-chip py-px">边 {edges.length}</span>
        <span className="ink-chip py-px ink-accent">新增 {diff.added.size}</span>
        <span className="ink-chip py-px">移除 {diff.removed.size}</span>
        <span className="ink-chip py-px">变更 {diff.changed.size}</span>
      </div>
      <div className="space-y-1.5">
        {nodes.map((node) => {
          const diffMark = diff.added.has(node.id) ? 'added' : diff.removed.has(node.id) ? 'removed' : diff.changed.has(node.id) ? 'changed' : 'none';
          return (
            <div
              key={node.id}
              data-ui={`arch_node_${node.id}`}
              data-diff={diffMark}
              className={cn(
                'ink-status-card flex items-center gap-2.5 px-3 py-2',
                diffMark === 'added' && 'border-[var(--ink-accent-border)]',
                diffMark === 'removed' && 'opacity-45',
                diffMark === 'changed' && 'border-[var(--ink-border-strong)]',
              )}
            >
              <span className="ink-icon-chip h-5 w-5">
                <GitBranch size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[var(--ink-font-xs)] font-medium">{node.label ?? node.id}</span>
                <span className="block font-mono text-[9px] ink-text-faint">{node.id} · {node.type}</span>
              </span>
              {diff.added.has(node.id) && <span className="ink-chip shrink-0 py-px text-[9px] ink-accent">新增</span>}
              {diff.removed.has(node.id) && <span className="ink-chip shrink-0 py-px text-[9px] ink-text-faint">移除</span>}
              {diff.changed.has(node.id) && <span className="ink-chip shrink-0 py-px text-[9px] ink-text-muted">变更</span>}
            </div>
          );
        })}
      </div>
      {edges.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-1">
          {edges.map((edge, index) => (
            <span key={`${edge.from}-${edge.to}-${index}`} className="font-mono text-[9px] ink-text-faint" data-ui="arch_edge">
              {edge.from} → {edge.to}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function emptyGraph(): GraphSnapshot {
  return { version: 0, nodes: [], edges: [], patchChain: [] };
}
