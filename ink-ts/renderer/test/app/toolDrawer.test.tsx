import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolDrawer } from '@/app/session/ToolDrawer';

describe('ToolDrawer', () => {
  it('renders when open', () => {
    render(<ToolDrawer open={true} onClose={() => {}} title="tool output"><div>content</div></ToolDrawer>);
    expect(screen.getByText('tool output')).toBeTruthy();
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('does not render when closed', () => {
    render(<ToolDrawer open={false} onClose={() => {}} title="tool output"><div>content</div></ToolDrawer>);
    expect(screen.queryByText('content')).toBeNull();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<ToolDrawer open={true} onClose={onClose} title="tool output"><div>content</div></ToolDrawer>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose on Escape key when open', () => {
    const onClose = vi.fn();
    render(<ToolDrawer open={true} onClose={onClose} title="tool output"><div>content</div></ToolDrawer>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not react to Escape when closed', () => {
    const onClose = vi.fn();
    render(<ToolDrawer open={false} onClose={onClose} title="tool output"><div>content</div></ToolDrawer>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
