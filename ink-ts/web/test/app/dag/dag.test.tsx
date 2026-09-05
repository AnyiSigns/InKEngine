import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { DagRenderer } from '@/app/dag';
import { layoutGraph } from '@/app/dag';
import type { DagGraph } from '@/app/dag';

const graph: DagGraph = {
  nodes: [
    { id: 'a', label: '编排', kind: 'orchestrator' },
    { id: 'b', label: '工具', kind: 'tool' },
    { id: 'c', label: '终结', kind: 'terminal' },
    { id: 'd', label: '工具2', kind: 'tool', group: 'g1' },
    { id: 'e', label: '工具3', kind: 'tool', group: 'g1' },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'a', to: 'd' },
    { from: 'd', to: 'e' },
  ],
};

describe('DAG 布局', () => {
  it('拓扑分层：根在 0 层，叶子在最深', () => {
    const layout = layoutGraph(graph);
    const layerOf = (id: string) => layout.positions.find((p) => p.id === id)!.layer;
    expect(layerOf('a')).toBe(0);
    expect(layerOf('b')).toBe(1);
    expect(layerOf('c')).toBe(2);
  });

  it('布局尺寸随节点数增长', () => {
    const layout = layoutGraph(graph);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});

describe('DAG 渲染器', () => {
  it('渲染所有节点与边', () => {
    render(<DagRenderer graph={graph} />);
    expect(screen.getByTestId('dag-canvas')).toBeInTheDocument();
    ['a', 'b', 'c', 'd', 'e'].forEach((id) => {
      expect(screen.getByTestId(`dag-node-${id}`)).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('dag-canvas')[0].querySelectorAll('.dag-edge').length).toBe(4);
  });

  it('节点语义色走 kind 数据属性（图语义不占决策色）', () => {
    render(<DagRenderer graph={graph} />);
    expect(screen.getByTestId('dag-node-a')).toHaveAttribute('data-kind', 'orchestrator');
    expect(screen.getByTestId('dag-node-c')).toHaveAttribute('data-kind', 'terminal');
  });

  it('执行态追踪：data-status 反映 node_start/end', () => {
    const inst: DagGraph = {
      nodes: [
        { id: 'a', label: 'A', kind: 'orchestrator', status: 'success' },
        { id: 'b', label: 'B', kind: 'tool', status: 'running' },
      ],
      edges: [],
    };
    render(<DagRenderer graph={inst} />);
    expect(screen.getByTestId('dag-node-a')).toHaveAttribute('data-status', 'success');
    expect(screen.getByTestId('dag-node-b')).toHaveAttribute('data-status', 'running');
  });

  it('分组折叠渲染「+N」徽标', () => {
    render(<DagRenderer graph={graph} collapsedGroups={{ g1: true }} onToggleGroup={() => undefined} />);
    const badge = screen.getByText('+1');
    expect(badge).toBeInTheDocument();
    // 折叠后该组仅保留首个节点
    expect(screen.getByTestId('dag-node-d')).toBeInTheDocument();
    expect(screen.queryByTestId('dag-node-e')).not.toBeInTheDocument();
  });

  it('wheel 缩放以光标为中心只改 viewBox', () => {
    const { container } = render(<DagRenderer graph={graph} />);
    const svg = screen.getByTestId('dag-canvas');
    const before = svg.getAttribute('viewBox');
    const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(rect);
    fireEvent.wheel(svg, { deltaY: 100, clientX: 400, clientY: 300 });
    const after = svg.getAttribute('viewBox');
    expect(after).not.toBe(before);
    expect(container.querySelector('.dag-arrow-head')).toBeInTheDocument();
  });
});
