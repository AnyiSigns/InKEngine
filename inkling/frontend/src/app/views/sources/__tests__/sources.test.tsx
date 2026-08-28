import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SourcesView } from '@/app/views/sources/SourcesView';

const traces = [
  { id: 't1', sourceType: 'memory' as const, title: '召回「项目规则」', detail: '命中 2 条相关记忆', createdAt: Date.now() - 60_000 },
  { id: 't2', sourceType: 'evidence' as const, title: 'vetting：shell', detail: '静态钩子核对通过', createdAt: Date.now() - 30_000 },
  { id: 't3', sourceType: 'device' as const, title: 'read_file', detail: '/tmp/a.txt', createdAt: Date.now() },
];

describe('来源·依据溯源时间线', () => {
  it('无留痕时展示空态', () => {
    render(<SourcesView traces={[]} />);
    expect(screen.getByText('暂无依据留痕')).toBeInTheDocument();
  });

  it('按来源类型分组展示留痕', () => {
    render(<SourcesView traces={traces} />);
    expect(screen.getByText('记忆召回')).toBeInTheDocument();
    expect(screen.getByText('审查与调优')).toBeInTheDocument();
    expect(screen.getByText('设备感知与控制')).toBeInTheDocument();
    expect(screen.getByText('召回「项目规则」')).toBeInTheDocument();
    expect(screen.getByText('vetting：shell')).toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();
  });

  it('展示详情与条数', () => {
    render(<SourcesView traces={traces} />);
    expect(screen.getByText('3 条留痕 · 按来源类型分组')).toBeInTheDocument();
    expect(screen.getByText('静态钩子核对通过')).toBeInTheDocument();
  });
});
