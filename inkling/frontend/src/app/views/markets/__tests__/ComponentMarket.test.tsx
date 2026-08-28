import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ComponentMarket } from '../ComponentMarket';
import { createAppBackend, type AppBackend } from '../../../backend';
import type { ComponentMarketEntry } from '../../../types';

function makeMockBackend(entries: ComponentMarketEntry[] = []): AppBackend {
  const backend = createAppBackend({ backend: { available: false } as never });
  vi.spyOn(backend, 'getComponentMarket').mockReturnValue(entries);
  return backend;
}

const sampleEntries: ComponentMarketEntry[] = [
  {
    id: 'test_comp_1',
    name: '测试组件 Alpha',
    source: 'test_agent',
    version: '0.1.0',
    risk: 'low',
    risk_note: '安全审查通过，无外部调用。',
    artifact_url: 'https://cdn.test/comp_alpha.js',
    test_manifest: { required: ['security_review'], note: '至少通过安全审查' },
    maintenance: 'maintained',
  },
  {
    id: 'test_comp_2',
    name: '测试组件 Beta',
    source: 'another_agent',
    version: '0.3.0-beta',
    risk: 'high',
    risk_note: '访问外部数据源，需 L2 审批。',
    artifact_url: 'https://cdn.test/comp_beta.js',
    test_manifest: { required: ['security_review', 'behavior_test'], note: '安全审查 + 行为测试' },
    maintenance: 'experimental',
  },
];

describe('ComponentMarket (W4.3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('从种子数据渲染组件列表', () => {
    const backend = makeMockBackend(sampleEntries);
    render(<ComponentMarket backend={backend} />);

    expect(screen.getByText('组件市场')).toBeTruthy();
    expect(screen.getByText('测试组件 Alpha')).toBeTruthy();
    expect(screen.getByText('测试组件 Beta')).toBeTruthy();
    expect(screen.getAllByText(/个候选组件/).length).toBeGreaterThan(0);
  });

  it('空态显示「暂无可用组件」', () => {
    const backend = makeMockBackend([]);
    render(<ComponentMarket backend={backend} />);

    expect(screen.getByText('暂无可用组件')).toBeTruthy();
  });

  it('点击详情打开抽屉，显示完整详情', async () => {
    const backend = makeMockBackend(sampleEntries);
    render(<ComponentMarket backend={backend} />);

    const detailBtn = screen.getAllByText('详情')[0];
    fireEvent.click(detailBtn!);

    await waitFor(() => {
      expect(screen.getByText('构件地址')).toBeTruthy();
    });
  });

  it('点击挂载触发 onMount 回调', () => {
    const backend = makeMockBackend(sampleEntries);
    const onMount = vi.fn();
    render(<ComponentMarket backend={backend} onMount={onMount} />);

    const mountBtns = screen.getAllByText('挂载');
    fireEvent.click(mountBtns[0]!);

    expect(onMount).toHaveBeenCalledWith(sampleEntries[0]);
  });

  it('风险徽标渲染正确（高=朱砂）', () => {
    const backend = makeMockBackend(sampleEntries);
    render(<ComponentMarket backend={backend} />);

    const highRisk = screen.getByText('高风险');
    expect(highRisk).toBeTruthy();
    expect(highRisk.className).toContain('ink-accent');
  });

  it('维护状态徽标渲染', () => {
    const backend = makeMockBackend(sampleEntries);
    render(<ComponentMarket backend={backend} />);

    expect(screen.getAllByText('维护中').length).toBeGreaterThan(0);
    expect(screen.getAllByText('实验性').length).toBeGreaterThan(0);
  });

  it('复制构件地址到剪贳板', async () => {
    const backend = makeMockBackend(sampleEntries);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<ComponentMarket backend={backend} />);

    const detailBtn = screen.getAllByText('详情')[0];
    fireEvent.click(detailBtn!);

    await waitFor(() => {
      const copyBtn = screen.getByText('复制');
      fireEvent.click(copyBtn!);
      expect(writeText).toHaveBeenCalledWith('https://cdn.test/comp_alpha.js');
    });
  });
});
