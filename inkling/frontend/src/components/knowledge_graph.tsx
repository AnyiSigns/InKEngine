/**
 * 知识关系可视化（拓扑维，区别于演化时间线的时间维）。
 *
 * 数据源：backendAdapter.knowledgeGraph（无宿主回落夹具数据）。节点 =
 * 知识条目（规则/模板/工具规则/权重），边 = 标签/引用/来源关系。力导
 * 布局（确定性种子，固定迭代，无随机漂移）；交互：节点点击入条目、
 * 折叠/展开收束关系边。大数据量降低迭代保渲染不卡。
 */

import { useMemo, useRef, useState, type MutableRefObject } from 'react';

import type { KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgeGraphResult } from '@/shared/backend/backendAdapter';
import { createBackend } from '@/shared/backend/backendAdapter';

const RELATION_COLOR: Record<KnowledgeGraphEdge['relation'], string> = {
  tag: 'var(--ink-accent)',
  reference: 'var(--ink-text-base)',
  source: 'var(--ink-text-muted)',
};

const KIND_GLYPH: Record<KnowledgeGraphNode['kind'], string> = {
  rule: 'R',
  template: 'T',
  tool_rule: 'U',
  weight: 'W',
};

function isValidGraph(value: unknown): value is KnowledgeGraphResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<KnowledgeGraphResult>;
  return Array.isArray(candidate.nodes) && Array.isArray(candidate.edges);
}

/** 确定性力导布局（Fruchterman-Reingold，种子为均匀圆，无随机）。 */
function layoutGraph(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 24;
  nodes.forEach((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
    positions.set(node.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  if (nodes.length <= 1) return positions;

  const iterations = nodes.length > 200 ? 60 : 300;
  const k = Math.sqrt((width * height) / nodes.length);
  for (let step = 0; step < iterations; step++) {
    const disp = new Map<string, { x: number; y: number }>();
    nodes.forEach((node) => disp.set(node.id, { x: 0, y: 0 }));
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = positions.get(nodes[i].id)!;
        const b = positions.get(nodes[j].id)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const force = (k * k) / dist;
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        const da = disp.get(nodes[i].id)!;
        const db = disp.get(nodes[j].id)!;
        da.x += dx; da.y += dy;
        db.x -= dx; db.y -= dy;
      }
    }
    for (const edge of edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      const da = disp.get(edge.source)!;
      const db = disp.get(edge.target)!;
      da.x -= dx; da.y -= dy;
      db.x += dx; db.y += dy;
    }
    const limit = width / 10;
    positions.forEach((pos, id) => {
      const d = disp.get(id)!;
      const len = Math.hypot(d.x, d.y) || 0.01;
      const capped = Math.min(len, limit);
      pos.x += (d.x / len) * capped + (cx - pos.x) * 0.02;
      pos.y += (d.y / len) * capped + (cy - pos.y) * 0.02;
      pos.x = Math.max(16, Math.min(width - 16, pos.x));
      pos.y = Math.max(16, Math.min(height - 16, pos.y));
    });
  }
  return positions;
}

interface KnowledgeGraphProps {
  bindValue?: unknown;
  /** 点击节点入条目回调（宿主接线打开知识条目） */
  onSelectEntry?: (id: string) => void;
}

export function KnowledgeGraph({ bindValue, onSelectEntry }: KnowledgeGraphProps) {
  const backend = useRef(createBackend());
  const [graph, setGraph] = useState<KnowledgeGraphResult | null>(() =>
    isValidGraph(bindValue) ? (bindValue as KnowledgeGraphResult) : null,
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const width = 420;
  const height = 280;

  useMemoLoad(bindValue, backend, setGraph, graph);

  const data = graph ?? { nodes: [], edges: [] };
  const positions = useMemo(
    () => layoutGraph(data.nodes, data.edges, width, height),
    [data.nodes, data.edges, width, height],
  );

  const visibleEdges = data.edges.filter(
    (edge) => !collapsed.has(edge.source) && !collapsed.has(edge.target),
  );

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const degree = useMemo(() => {
    const map = new Map<string, number>();
    for (const edge of data.edges) {
      map.set(edge.source, (map.get(edge.source) ?? 0) + 1);
      map.set(edge.target, (map.get(edge.target) ?? 0) + 1);
    }
    return map;
  }, [data.edges]);

  return (
    <section className="ink-panel p-4" data-ui="knowledge_graph">
      <div className="flex items-center gap-2.5">
        <span className="ink-icon-chip">
          <span className="text-[10px] font-semibold">拓</span>
        </span>
        <span className="text-[12px] font-semibold tracking-tight">知识关系</span>
        <span className="ml-auto text-[10px] ink-text-faint">{data.nodes.length} 条目 · {data.edges.length} 关系</span>
      </div>

      {data.nodes.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-5 text-center text-[11px] ink-border ink-text-faint">
          知识关系为空（条目经沉淀后在此成网）
        </div>
      ) : (
        <svg
          className="ink-chart-host mt-3 w-full"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          data-ui="knowledge_graph_svg"
        >
          {visibleEdges.map((edge) => {
            const a = positions.get(edge.source);
            const b = positions.get(edge.target);
            if (!a || !b) return null;
            return (
              <line
                key={`${edge.source}->${edge.target}`}
                data-edge={`${edge.source}->${edge.target}`}
                data-relation={edge.relation}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={RELATION_COLOR[edge.relation]}
                strokeWidth={1.2}
                strokeOpacity={0.7}
              />
            );
          })}
          {data.nodes.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            const isCollapsed = collapsed.has(node.id);
            return (
              <g
                key={node.id}
                data-node={node.id}
                className="cursor-pointer"
                onClick={() => onSelectEntry?.(node.id)}
              >
                <circle cx={pos.x} cy={pos.y} r={11} className="ink-graph-node" fill="var(--ink-bg-elevated)" stroke="var(--ink-border-strong)" />
                <text x={pos.x} y={pos.y + 3} textAnchor="middle" fontSize="9" className="ink-text-muted" style={{ pointerEvents: 'none' }}>
                  {KIND_GLYPH[node.kind]}
                </text>
                <text x={pos.x} y={pos.y + 22} textAnchor="middle" fontSize="8.5" className="ink-text-faint" style={{ pointerEvents: 'none' }}>
                  {truncate(node.label, 8)}
                </text>
                {(degree.get(node.id) ?? 0) > 0 && (
                  <g
                    data-collapse={`${node.id}:${isCollapsed ? 'collapsed' : 'expanded'}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle(node.id);
                    }}
                  >
                    <circle cx={pos.x + 11} cy={pos.y - 11} r={6} fill={isCollapsed ? 'var(--ink-accent)' : 'var(--ink-bg-base)'} stroke="var(--ink-border-strong)" />
                    <text x={pos.x + 11} y={pos.y - 8} textAnchor="middle" fontSize="9" style={{ pointerEvents: 'none' }}>
                      {isCollapsed ? '+' : '−'}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      )}

      <div className="mt-2 flex flex-wrap gap-2 text-[9px] ink-text-faint">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: RELATION_COLOR.tag }} />标签</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: RELATION_COLOR.reference }} />引用</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: RELATION_COLOR.source }} />来源</span>
      </div>
    </section>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 数据加载（bindValue 优先；否则经后端契约，无宿主回落夹具）。
 * 独立小钩子，避免条件分支嵌套影响可读性与测试稳定性。
 */
function useMemoLoad(
  bindValue: unknown,
  backend: MutableRefObject<ReturnType<typeof createBackend>>,
  setGraph: (value: KnowledgeGraphResult) => void,
  current: KnowledgeGraphResult | null,
): void {
  const loadedRef = useRef(false);
  if (current === null && !loadedRef.current && !isValidGraph(bindValue)) {
    loadedRef.current = true;
    if (backend.current.available) {
      backend.current
        .knowledgeGraph()
        .then((result) => setGraph(result))
        .catch(() => setGraph({ nodes: [], edges: [] }));
    } else {
      setGraph({ nodes: [], edges: [] });
    }
  }
}
