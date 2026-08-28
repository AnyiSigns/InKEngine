import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MemoryView } from '../MemoryView';
import { sourceLabel, kindLabel } from '../backend';

describe('MemoryView', () => {
  it('空态渲染', () => {
    render(<MemoryView />);
    expect(screen.getByText(/尚无记忆/)).toBeInTheDocument();
  });
});

describe('sourceLabel', () => {
  it('round_liquid 提取', () => {
    expect(sourceLabel('round_liquid')).toBe('round_liquid 提取');
  });
  it('人工录入', () => {
    expect(sourceLabel('manual')).toBe('人工录入');
  });
  it('种子数据', () => {
    expect(sourceLabel('seed')).toBe('种子数据');
  });
});

describe('kindLabel', () => {
  it('决策', () => {
    expect(kindLabel('decision')).toBe('决策');
  });
  it('领域窗口', () => {
    expect(kindLabel('domain_window')).toBe('领域窗口');
  });
});
