/**
 * 知识关系可视化：节点/边渲染 + 展开折叠交互 + 点击入条目。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { KnowledgeGraph, KNOWLEDGE_GRAPH_FIXTURE } from '@/components/knowledge_graph';
import type { KnowledgeGraphResult } from '@/shared/backend/backendAdapter';

function pair(): KnowledgeGraphResult {
  return {
    nodes: [
      { id: 'a', label: '规则甲', kind: 'rule', tags: ['节奏'] },
      { id: 'b', label: '模板乙', kind: 'template', tags: ['计划'] },
    ],
    edges: [{ source: 'a', target: 'b', relation: 'reference' }],
  };
}

describe('knowledge_graph：节点/边渲染', () => {
  it('渲染节点与关系边', () => {
    const { container } = render(<KnowledgeGraph bindValue={pair()} />);
    expect(container.querySelector('[data-node="a"]')).toBeInTheDocument();
    expect(container.querySelector('[data-node="b"]')).toBeInTheDocument();
    expect(container.querySelector('[data-edge="a->b"]')).toBeInTheDocument();
    expect(container.querySelector('[data-relation="reference"]')).toBeInTheDocument();
  });

  it('无宿主时回落夹具数据仍可渲染', () => {
    const { container } = render(<KnowledgeGraph />);
    expect(container.querySelector(`[data-node="${KNOWLEDGE_GRAPH_FIXTURE.nodes[0].id}"]`)).toBeInTheDocument();
    expect(container.querySelectorAll('[data-node]').length).toBe(KNOWLEDGE_GRAPH_FIXTURE.nodes.length);
  });

  it('空数据态不崩', () => {
    render(<KnowledgeGraph bindValue={{ nodes: [], edges: [] }} />);
    expect(screen.getByText(/知识关系为空/)).toBeInTheDocument();
  });
});

describe('knowledge_graph：展开/折叠交互', () => {
  it('折叠收束关系边，展开恢复', async () => {
    const user = userEvent.setup();
    const { container } = render(<KnowledgeGraph bindValue={pair()} />);
    const edge = container.querySelector('[data-edge="a->b"]');
    expect(edge).toBeInTheDocument();

    const collapse = container.querySelector('[data-collapse="a:expanded"]');
    expect(collapse).toBeInTheDocument();
    await user.click(collapse as Element);

    expect(container.querySelector('[data-edge="a->b"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-collapse="a:collapsed"]')).toBeInTheDocument();

    await user.click(container.querySelector('[data-collapse="a:collapsed"]') as Element);
    expect(container.querySelector('[data-edge="a->b"]')).toBeInTheDocument();
  });
});

describe('knowledge_graph：点击入条目', () => {
  it('点击节点触发回调', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { container } = render(<KnowledgeGraph bindValue={pair()} onSelectEntry={onSelect} />);
    await user.click(container.querySelector('[data-node="a"]') as Element);
    expect(onSelect).toHaveBeenCalledWith('a');
  });
});
