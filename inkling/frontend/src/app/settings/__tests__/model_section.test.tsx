/**
 * 模型节新布局测试（提供方列表 → 添加按钮 → router/audit 档位选择 → 推演档位 → 全局压缩阈值）：
 * - 空态：整页引导 + 「+ 添加提供方」「+ 添加自定义提供方」两入口；
 * - 添加提供方 → 弹窗（厂商模板：自动带端点 + 探测模型默认全选）；
 * - 添加自定义提供方 → 弹窗（APi 协议按协议添加）；
 * - 读回显 providers 数组形态 → 提供方行渲染 + router/audit 回填 + 不显示空态；
 * - 全局压缩阈值（单值）落盘所有提供方。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let mockConfig: Record<string, unknown> = {};

const backendMock = {
  available: true,
  modelsConfigGet: vi.fn(async () => mockConfig),
  modelsConfigPut: vi.fn(async (_config: unknown) => ({ ok: true })),
  capabilityPut: vi.fn(async () => ({})),
  modelArchiveSnapshot: vi.fn(async () => ({ archives: [] })),
  modelsRefresh: vi.fn(async () => ({ ok: true, mode: 'success' })),
};

vi.mock('@/shared/backend/backendAdapter', () => ({
  createBackend: () => backendMock,
}));

import { ModelSection } from '@/app/settings/sections/model_section';

describe('ModelSection 空态引导', () => {
  it('厂商空（无连接配置）→ 引导文案 + 两个添加入口', async () => {
    mockConfig = {};
    render(<ModelSection />);
    expect(await screen.findByText(/填入各提供方的 API 密钥即可使用其模型/)).toBeTruthy();
    expect(screen.getByText('+ 添加提供方')).toBeTruthy();
    expect(screen.getByText('+ 添加自定义提供方')).toBeTruthy();
  });

  it('点击「+ 添加提供方」→ 打开添加弹窗（厂商模板）', async () => {
    const user = userEvent.setup();
    mockConfig = {};
    render(<ModelSection />);
    await user.click(await screen.findByText('+ 添加提供方'));
    expect(screen.getByLabelText('厂商模板')).toBeTruthy();
    expect(screen.getByLabelText('provider_url')).toBeTruthy();
  });

  it('厂商模板下拉不含协议变体；确定时保存该厂商绑定的协议适配器', async () => {
    const user = userEvent.setup();
    mockConfig = {};
    render(<ModelSection />);
    await user.click(await screen.findByText('+ 添加提供方'));
    const vendorSelect = screen.getByLabelText('厂商模板') as HTMLSelectElement;
    const labels = Array.from(vendorSelect.options).map((o) => o.textContent);
    // 协议变体不混入模板
    expect(labels).not.toContain('OpenAI Responses');
    expect(labels).not.toContain('Anthropic Messages');
    // 选中 Anthropic → 确定 → 保存 adapter = anthropic_messages（非 vendor id）
    await user.selectOptions(vendorSelect, 'anthropic');
    await user.click(screen.getByText('确定'));
    expect(backendMock.modelsConfigPut).toHaveBeenCalled();
    const payload = backendMock.modelsConfigPut.mock.calls.at(-1)![0] as unknown as { providers: Array<Record<string, unknown>> };
    expect(payload.providers[0].adapter).toBe('anthropic_messages');
  });

  it('点击「+ 添加自定义提供方」→ 打开添加弹窗（API 协议）', async () => {
    const user = userEvent.setup();
    mockConfig = {};
    render(<ModelSection />);
    await user.click(await screen.findByText('+ 添加自定义提供方'));
    expect(screen.getByLabelText('API 协议')).toBeTruthy();
    expect(screen.getByLabelText('provider_id')).toBeTruthy();
  });

  it('读回显 providers 数组形态：渲染提供方行 + router/audit 回填 + 无「暂无提供方」', async () => {
    mockConfig = {
      providers: [
        {
          provider_id: 'moonshot',
          vendor: 'moonshot',
          adapter: 'openai_compatible',
          base_url: 'http://m/v1',
          api_key: 'sk-m',
          model_ids: { router: 'kimi-lite', audit: 'kimi-audit' },
          models: ['kimi', 'kimi-lite', 'kimi-audit'],
          compression_percent: 70,
        },
      ],
    };
    render(<ModelSection />);
    expect(await screen.findByText('Moonshot')).toBeTruthy();
    expect(screen.queryByText('暂无提供方，请添加一个提供方以使用模型。')).toBeNull();
    // router/audit 回填
    expect(screen.getByText('kimi-lite')).toBeTruthy();
    expect(screen.getByText('kimi-audit')).toBeTruthy();
  });

  it('切换 router 档位模型 → 落盘携带该档位 model_id', async () => {
    const user = userEvent.setup();
    mockConfig = {
      providers: [
        {
          provider_id: 'moonshot',
          vendor: 'moonshot',
          base_url: 'http://m/v1',
          model_ids: {},
          models: ['kimi', 'kimi-lite'],
          compression_percent: 70,
        },
      ],
    };
    const { container } = render(<ModelSection />);
    const toggle = container.querySelector('[data-ui="tier_model_toggle_router"]') as HTMLElement;
    await user.click(toggle);
    const option = await screen.findByText('kimi');
    await user.click(option);
    expect(backendMock.modelsConfigPut).toHaveBeenCalled();
    const payload = backendMock.modelsConfigPut.mock.calls.at(-1)![0] as unknown as { providers: Array<Record<string, unknown>> };
    expect(payload.providers[0].model_ids).toMatchObject({ router: 'kimi' });
  });

  it('全局压缩阈值单值落盘到所有提供方', async () => {
    mockConfig = {
      providers: [
        { provider_id: 'a', base_url: 'http://a/v1', compression_percent: 80 },
        { provider_id: 'b', base_url: 'http://b/v1', compression_percent: 80 },
      ],
    };
    render(<ModelSection />);
    // 拖动压缩阈值滑杆
    const slider = await screen.findByLabelText('压缩阈值');
    fireEvent.change(slider, { target: { value: '50' } });
    await vi.waitFor(() => expect(backendMock.modelsConfigPut).toHaveBeenCalled());
    const payload = backendMock.modelsConfigPut.mock.calls.at(-1)![0] as unknown as { providers: Array<Record<string, unknown>> };
    const values = payload.providers.map((p) => p.compression_percent);
    expect(new Set(values).size).toBe(1);
  });
});
