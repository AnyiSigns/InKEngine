import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { KnowledgePanel } from '@/app/knowledge/KnowledgePanel';
import { credibilityLevel, credibilityLabel, compareCredibility } from '@/app/knowledge/backend';
import type { KnowledgeEntry } from '@/app/knowledge/backend';

describe('KnowledgePanel', () => {
  it('宿主不可用（无 serve 通道）= unavailable 三态', async () => {
    render(<KnowledgePanel />);
    const matches = await screen.findAllByText(/宿主不可用/);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe('credibilityLevel', () => {
  it('高可信度', () => {
    expect(credibilityLevel(0.9)).toBe('high');
  });
  it('中可信度', () => {
    expect(credibilityLevel(0.6)).toBe('medium');
  });
  it('低可信度', () => {
    expect(credibilityLevel(0.3)).toBe('low');
  });
});

describe('credibilityLabel', () => {
  it('高', () => {
    expect(credibilityLabel('high')).toBe('高');
  });
  it('中', () => {
    expect(credibilityLabel('medium')).toBe('中');
  });
  it('低', () => {
    expect(credibilityLabel('low')).toBe('低');
  });
});

describe('compareCredibility', () => {
  it('按可信度降序', () => {
    const a: KnowledgeEntry = { id: 'a', credibility: 0.9 } as KnowledgeEntry;
    const b: KnowledgeEntry = { id: 'b', credibility: 0.5 } as KnowledgeEntry;
    expect(compareCredibility(a, b)).toBeLessThan(0);
  });
});
