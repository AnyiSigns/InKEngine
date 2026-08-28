import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PhaseCapsule } from '../session/PhaseCapsule';

describe('PhaseCapsule', () => {
  it('renders steps when expanded', () => {
    render(<PhaseCapsule steps={[{ id: '1', label: '规划', status: 'running' }]} />);
    fireEvent.click(screen.getByText('展开'));
    expect(screen.getByText('规划')).toBeTruthy();
  });

  it('renders chain label', () => {
    render(<PhaseCapsule steps={[]} chainLabel="研究链" />);
    expect(screen.getByText('研究链')).toBeTruthy();
  });
});
