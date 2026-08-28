import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { KnowledgePanel } from '../KnowledgePanel';
import { credibilityLevel, credibilityLabel, compareCredibility } from '../backend';
import type { KnowledgeEntry } from '../backend';

describe('KnowledgePanel', () => {
  it('空态渲染', () => {
    render(<KnowledgePanel />);
    expect(screen.getByText(/知识库为空/)).toBeInTheDocument();
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
