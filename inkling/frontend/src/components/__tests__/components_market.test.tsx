/**
 * 组件市场（P4.6）：seed JSON schema 校验 + 前端列表渲染断言。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';

import {
  ComponentsMarket,
  COMPONENTS_MARKET_DEFAULT,
  validateComponentsMarket,
  type ComponentMarket,
} from '@/components/components_market';
import userEvent from '@testing-library/user-event';

const seedPath = resolve(process.cwd(), '..', 'seed_data', 'components_market.json');
const seed = JSON.parse(readFileSync(seedPath, 'utf-8')) as ComponentMarket;

describe('components_market：seed JSON schema 校验（仿 mcp_market 字段）', () => {
  it('出厂 seed 文件通过校验', () => {
    const result = validateComponentsMarket(seed);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('前端内置候选清单与 seed 同源同口径', () => {
    expect(validateComponentsMarket(COMPONENTS_MARKET_DEFAULT).ok).toBe(true);
    expect(COMPONENTS_MARKET_DEFAULT.components.length).toBeGreaterThanOrEqual(2);
  });

  it('缺失字段被捕获', () => {
    const broken = { ...seed, components: [{ id: 'x', name: '坏', risk: 'weird' }] };
    const result = validateComponentsMarket(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('risk');
  });
});

describe('components_market：前端列表渲染（来源信誉展示）', () => {
  it('渲染候选条目 + 风险档 + 维护状态', () => {
    const { container } = render(<ComponentsMarket />);
    expect(screen.getByText('专注仪表盘')).toBeInTheDocument();
    expect(screen.getByText('网页摘录')).toBeInTheDocument();
    expect(container.querySelector('[data-risk="low"]')).toBeInTheDocument();
    expect(container.querySelector('[data-risk="high"]')).toBeInTheDocument();
    expect(container.querySelector('[data-maintenance="maintained"]')).toBeInTheDocument();
    expect(container.querySelector('[data-maintenance="experimental"]')).toBeInTheDocument();
  });

  it('挂载按钮可触发回调', async () => {
    const user = userEvent.setup();
    const onMount = vi.fn();
    render(<ComponentsMarket onMount={onMount} />);
    await user.click(screen.getAllByText('挂载')[0]);
    expect(onMount).toHaveBeenCalled();
  });

  it('空清单不崩', () => {
    render(<ComponentsMarket bindValue={{ premounted: false, mount_policy: { required: [], note: '' }, components: [] }} />);
    expect(screen.getByText(/组件市场为空/)).toBeInTheDocument();
  });
});
