import { useMemo, useRef, useState, type WheelEvent } from 'react';

import { layoutGraph, edgePath } from './layout';
import type { DagGraph } from './types';
import { DAG_NODE_H, DAG_NODE_W } from './types';
import './dag.css';

export interface DagRendererProps {
  graph: DagGraph;
  /** 折叠的分组键集合。 */
  collapsedGroups?: Record<string, boolean>;
  onToggleGroup?: (group: string) => void;
  onNodeClick?: (nodeId: string) => void;
  /** 测试/无障碍标签前缀。 */
  ariaLabel?: string;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function kindClass(kind: DagGraph['nodes'][number]['kind']): string {
  if (kind === 'orchestrator') return 'dag-node--orchestrator';
  if (kind === 'tool') return 'dag-node--tool';
  return 'dag-node--terminal';
}

/** 自研 SVG DAG 渲染器：g 节点 + 贝塞尔边 + marker 箭头；wheel 缩放以光标为中心只改 viewBox。 */
export function DagRenderer({
  graph,
  collapsedGroups = {},
  onToggleGroup,
  onNodeClick,
  ariaLabel = 'DAG 图',
}: DagRendererProps) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewBox, setViewBox] = useState<ViewBox>({
    x: 0,
    y: 0,
    w: layout.width,
    h: layout.height,
  });

  const posById = useMemo(() => {
    const m = new Map<string, (typeof layout.positions)[number]>();
    for (const p of layout.positions) m.set(p.id, p);
    return m;
  }, [layout]);

  // 折叠：每个 group 仅保留首个节点，渲染「+N」徽标
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of graph.nodes) if (n.group) counts[n.group] = (counts[n.group] ?? 0) + 1;
    return counts;
  }, [graph.nodes]);

  const visible = useMemo(() => {
    const seen = new Set<string>();
    return layout.positions.filter((p) => {
      const g = p.node.group;
      if (g && collapsedGroups[g]) {
        if (seen.has(g)) return false;
        seen.add(g);
      }
      return true;
    });
  }, [layout.positions, collapsedGroups]);

  const visibleIds = new Set(visible.map((v) => v.id));
  const edges = graph.edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));

  function handleWheel(e: WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * viewBox.w + viewBox.x;
    const py = ((e.clientY - rect.top) / rect.height) * viewBox.h + viewBox.y;
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const nextW = Math.min(Math.max(viewBox.w * factor, DAG_NODE_W), layout.width * 4);
    const nextH = nextW * (viewBox.h / viewBox.w);
    setViewBox({
      x: px - (px - viewBox.x) * (nextW / viewBox.w),
      y: py - (py - viewBox.y) * (nextH / viewBox.h),
      w: nextW,
      h: nextH,
    });
  }

  return (
    <svg
      ref={svgRef}
      className="dag-canvas"
      role="img"
      aria-label={ariaLabel}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
      onWheel={handleWheel}
      data-testid="dag-canvas"
    >
      <defs>
        <marker
          id="dag-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="dag-arrow-head" />
        </marker>
      </defs>
      <g className="dag-edges">
        {edges.map((e) => {
          const a = posById.get(e.from);
          const b = posById.get(e.to);
          if (!a || !b) return null;
          return (
            <path
              key={`${e.from}->${e.to}`}
              d={edgePath(a, b)}
              className="dag-edge"
              markerEnd="url(#dag-arrow)"
              fill="none"
            />
          );
        })}
      </g>
      <g className="dag-nodes">
        {visible.map((p) => {
          const g = p.node.group;
          const collapsed = !!g && collapsedGroups[g];
          const badge = collapsed && g ? groupCounts[g] - 1 : 0;
          return (
            <g
              key={p.id}
              className={`dag-node ${kindClass(p.node.kind)} ${p.node.status ? `dag-node--${p.node.status}` : ''}`}
              transform={`translate(${p.x}, ${p.y})`}
              data-kind={p.node.kind}
              data-status={p.node.status ?? 'idle'}
              data-node-id={p.id}
              data-testid={`dag-node-${p.id}`}
              onClick={() => onNodeClick?.(p.id)}
              role="button"
              aria-label={`${p.node.label}（${p.node.kind}）`}
            >
              <rect width={DAG_NODE_W} height={DAG_NODE_H} rx="8" className="dag-node-box" />
              <text x="14" y={DAG_NODE_H / 2 + 4} className="dag-node-label">
                {p.node.label}
              </text>
              {collapsed && onToggleGroup && (
                <g
                  className="dag-group-badge"
                  transform={`translate(${DAG_NODE_W - 40}, ${DAG_NODE_H - 22})`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onToggleGroup(g!);
                  }}
                  role="button"
                  aria-label={`展开分组 ${g}（${badge} 个折叠）`}
                >
                  <rect width="32" height="18" rx="9" />
                  <text x="16" y="13" textAnchor="middle">
                    +{badge}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
