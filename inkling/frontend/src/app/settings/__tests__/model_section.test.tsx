/**
 * 模型节空态引导 + providers 数组形态测试：
 * - 厂商空 → 「填入各提供方的 API 密钥即可使用其模型」+ 主按钮「+添加提供方」
 *   打开 main 档配置悬浮窗（设计 §1.4 首次空态）；
 * - 读回显 providers 数组形态 → 字段回填、不显示空态。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let mockConfig: Record<string, unknown> = {};

vi.mock('@/shared/backend/backendAdapter', () => ({
  createBackend: () => ({
    available: true,
    modelsConfigGet: vi.fn(async () => mockConfig),
    modelsConfigPut: vi.fn(async () => ({ ok: true })),
    capabilityPut: vi.fn(async () => ({})),
    modelArchiveSnapshot: vi.fn(async () => ({ archives: [] })),
  }),
}));

import { ModelSection } from '@/app/settings/sections/model_section';

describe('ModelSection 空态引导', () => {
  it('厂商空（无连接配置）→ 空态页 + 主按钮', async () => {
    mockConfig = {};
    render(<ModelSection />);
    expect(await screen.findByText('填入各提供方的 API 密钥即可使用其模型')).toBeTruthy();
    expect(screen.getByText('+ 添加提供方')).toBeTruthy();
    // 无提供方 → 不显示档位编辑块（空态引导独占首屏）
    expect(screen.queryByText('模型档位')).toBeNull();
  });

  it('点击「+ 添加提供方」→ 打开 main 档配置悬浮窗', async () => {
    const user = userEvent.setup();
    mockConfig = {};
    render(<ModelSection />);
    await user.click(await screen.findByText('+ 添加提供方'));
    expect(screen.getByText('配置main')).toBeTruthy();
    expect(screen.getByLabelText('厂商')).toBeTruthy();
  });

  it('读回显 providers 数组形态：字段回填且不显示空态', async () => {
    mockConfig = {
      providers: [
        {
          provider_id: 'moonshot',
          adapter: 'openai_compatible',
          base_url: 'http://m/v1',
          api_key: 'sk-m',
          model_ids: { main: 'kimi', router: 'kimi-lite' },
          context_window: 131072,
          compression_percent: 70,
        },
      ],
    };
    render(<ModelSection />);
    // providers 读回显 → 主档 model_id 回填（列表卡 + 档位卡）→ 不显示空态引导
    expect((await screen.findAllByText('kimi')).length).toBeGreaterThan(0);
    expect(screen.queryByText('填入各提供方的 API 密钥即可使用其模型')).toBeNull();
  });

  it('多提供方：列表渲染多卡 + 切换编辑当前提供方', async () => {
    const user = userEvent.setup();
    mockConfig = {
      providers: [
        {
          provider_id: 'openai',
          vendor: 'openai',
          adapter: 'openai_compatible',
          base_url: 'http://o/v1',
          model_ids: { main: 'gpt-4o' },
        },
        {
          provider_id: 'moonshot',
          vendor: 'moonshot',
          adapter: 'openai_compatible',
          base_url: 'http://m/v1',
          model_ids: { main: 'kimi' },
        },
      ],
    };
    render(<ModelSection />);
    // 列表双卡
    expect(await screen.findByText('OpenAI（Compatible）')).toBeTruthy();
    expect(screen.getByText('Moonshot')).toBeTruthy();
    // 默认编辑第一提供方（gpt-4o 入档位卡）
    expect(screen.getAllByText('gpt-4o').length).toBeGreaterThan(0);
    // 切换第二提供方 → 档位卡显示 kimi
    await user.click(screen.getByText('Moonshot'));
    expect(screen.getAllByText('kimi').length).toBeGreaterThan(0);
  });

  it('添加提供方 → 追加新卡并打开配置悬浮窗', async () => {
    const user = userEvent.setup();
    mockConfig = {
      providers: [
        {
          provider_id: 'moonshot',
          vendor: 'moonshot',
          adapter: 'openai_compatible',
          base_url: 'http://m/v1',
          model_ids: { main: 'kimi' },
        },
      ],
    };
    render(<ModelSection />);
    await user.click(await screen.findByText('+ 添加提供方'));
    // 新提供方卡出现（第二个 openai）
    expect(screen.getAllByText('OpenAI（Compatible）')).toHaveLength(2);
    // 配置悬浮窗打开（新提供方 main 档）
    expect(screen.getByText('配置main')).toBeTruthy();
  });
});
