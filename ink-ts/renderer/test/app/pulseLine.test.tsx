import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PulseLine } from '@/app/session/PulseLine';

describe('PulseLine', () => {
  it('renders text', () => {
    render(<PulseLine text="正在思考…" />);
    expect(screen.getByText('正在思考…')).toBeTruthy();
  });
});
