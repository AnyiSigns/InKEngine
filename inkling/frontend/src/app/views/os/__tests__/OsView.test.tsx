import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { OsView } from '../OsView';

describe('OsView (W5.3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染 OS 层视图标题', () => {
    render(<OsView />);
    expect(screen.getByText('OS 层')).toBeTruthy();
  });

  it('设备感知卡渲染', () => {
    render(<OsView />);
    expect(screen.getByText('设备感知')).toBeTruthy();
    expect(screen.getByText('查询屏幕 / UI 树')).toBeTruthy();
  });

  it('设备感知查询结果内联展示', async () => {
    render(<OsView />);
    const senseBtn = screen.getByText('查询屏幕 / UI 树');
    fireEvent.click(senseBtn!);
    await waitFor(() => {
      expect(screen.getAllByText(/屏幕/).length).toBeGreaterThan(0);
    });
  });

  it('截图按钮渲染（vision.json 门控）', () => {
    render(<OsView />);
    expect(screen.getByText('截图')).toBeTruthy();
  });

  it('文档入口渲染', () => {
    render(<OsView />);
    expect(screen.getAllByText('解析文档').length).toBeGreaterThan(0);
    expect(screen.getAllByText('生成文档').length).toBeGreaterThan(0);
  });

  it('测试运行器一键触发按钮', () => {
    render(<OsView />);
    expect(screen.getByText('类型检查')).toBeTruthy();
    expect(screen.getByText('Rust 测试')).toBeTruthy();
    expect(screen.getByText('Python 测试')).toBeTruthy();
    expect(screen.getByText('Web 测试')).toBeTruthy();
  });

  it('测试运行器参数模板不可篡改', () => {
    render(<OsView />);
    expect(screen.getByText('npx tsc --noEmit')).toBeTruthy();
    expect(screen.getByText('cargo test')).toBeTruthy();
    expect(screen.getByText('pytest')).toBeTruthy();
    expect(screen.getByText('vitest run')).toBeTruthy();
  });

  it('shell_exec 作为 deny 档样例展示（待接入）', () => {
    render(<OsView />);
    expect(screen.getByText('deny 档样例')).toBeTruthy();
    expect(screen.getByText('（待接入 — shell_exec 不放行）')).toBeTruthy();
  });

  it('网络越域提示：域名不在白名单时显示警示', async () => {
    render(<OsView networkAllowlist="example.com" />);
    const input = screen.getByPlaceholderText('输入域名或 URL');
    fireEvent.change(input!, { target: { value: 'evil-hacker.com' } });
    const checkBtn = screen.getByText('检查');
    fireEvent.click(checkBtn!);
    await waitFor(() => {
      expect(screen.getByText('evil-hacker.com — 目标域名不在白名单')).toBeTruthy();
    });
    expect(screen.getByText('越境拒绝')).toBeTruthy();
    expect(screen.getByText('管理白名单')).toBeTruthy();
  });

  it('网络越域提示：域名在白名单时不显示警示', async () => {
    render(<OsView networkAllowlist="example.com" />);
    const input = screen.getByPlaceholderText('输入域名或 URL');
    fireEvent.change(input!, { target: { value: 'example.com' } });
    const checkBtn = screen.getByText('检查');
    fireEvent.click(checkBtn!);
    await waitFor(() => {
      expect(screen.getByText('example.com — 在白名单内')).toBeTruthy();
    });
  });

  it('URL 输入时提取域名判断', async () => {
    render(<OsView networkAllowlist="example.com" />);
    const input = screen.getByPlaceholderText('输入域名或 URL');
    fireEvent.change(input!, { target: { value: 'https://evil-hacker.com/path' } });
    const checkBtn = screen.getByText('检查');
    fireEvent.click(checkBtn!);
    await waitFor(() => {
      expect(screen.getByText('evil-hacker.com — 目标域名不在白名单')).toBeTruthy();
    });
  });

  it('环境容器节禁用态', () => {
    render(<OsView />);
    expect(screen.getByText(/默认禁外发/)).toBeTruthy();
  });
});
