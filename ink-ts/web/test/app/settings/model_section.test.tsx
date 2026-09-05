/**
 * 模型节布局测试（提供方列表 → 添加按钮 → router 档位选择 → 推演档位 → 全局压缩阈值）：
 * - 空态：整页引导 + 「+ 添加提供方」「+ 添加自定义提供方」两入口；
 * - 添加提供方 → 弹窗（厂商模板：自动带端点 + 探测模型默认全选）；
 * - 添加自定义提供方 → 弹窗（APi 协议按协议添加）；
 * - 读回显 providers 数组形态 → 提供方行渲染 + router 回填 + 不显示空态；
 * - 全局压缩阈值（单值）落盘所有提供方。
 *
 * 档位槽只有 router：agent = 对话主模型在输入框自选，不占设置页槽位；
 * audit 复核槽已从引擎角色收敛中删除，不渲染、不落盘。
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

  it('读回显 providers 数组形态：渲染提供方行 + router 回填 + 无「暂无提供方」', async () => {
    mockConfig = {
      providers: [
        {
          provider_id: 'moonshot',
          vendor: 'moonshot',
          adapter: 'openai_compatible',
          base_url: 'http://m/v1',
          api_key: 'sk-m',
          model_ids: { router: 'kimi-lite' },
          models: ['kimi', 'kimi-lite', 'kimi-audit'],
          compression_percent: 70,
        },
      ],
    };
    render(<ModelSection />);
    expect(await screen.findByText('Moonshot')).toBeTruthy();
    expect(screen.queryByText('暂无提供方，请添加一个提供方以使用模型。')).toBeNull();
    // router 回填；audit 槽位不再渲染
    expect(screen.getByText('kimi-lite')).toBeTruthy();
    expect(screen.queryByText('kimi-audit')).toBeNull();
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

  it('取消添加弹窗不落盘（探测仅预览，持久化只发生在显式保存）', async () => {
    const user = userEvent.setup();
    mockConfig = {};
    render(<ModelSection />);
    backendMock.modelsConfigPut.mockClear();
    await user.click(await screen.findByText('+ 添加自定义提供方'));
    // 填 url/api_key 触发探测（models_refresh 只探测不写连接配置）
    const url = screen.getByLabelText('provider_url');
    await user.type(url, 'http://probe/v1');
    await user.click(screen.getByText('取消'));
    expect(backendMock.modelsConfigPut).not.toHaveBeenCalled();
    // 弹窗关闭后无幽灵 provider
    expect(screen.queryByText(/http:\/\/probe\/v1/)).toBeNull();
  });

  it('删除提供方 = 整表替换（被删提供方不再出现在落盘 providers）', async () => {
    const user = userEvent.setup();
    mockConfig = {
      providers: [
        { provider_id: 'a', vendor: 'a', base_url: 'http://a/v1', api_key: 'sk-a' },
        { provider_id: 'b', vendor: 'b', base_url: 'http://b/v1', api_key: 'sk-b' },
      ],
    };
    const { container } = render(<ModelSection />);
    await screen.findByText('a');
    backendMock.modelsConfigPut.mockClear();
    const deleteButtons = container.querySelectorAll('[data-ui="provider_delete"]');
    await user.click(deleteButtons[1] as HTMLElement);
    await vi.waitFor(() => expect(backendMock.modelsConfigPut).toHaveBeenCalled());
    const payload = backendMock.modelsConfigPut.mock.calls.at(-1)![0] as unknown as { providers: Array<Record<string, unknown>> };
    const ids = payload.providers.map((p) => p.provider_id);
    expect(ids).toEqual(['a']);
  });

  it('选择提供方 = 切当前连接：档位候选跟随该提供方模型清单', async () => {
    const user = userEvent.setup();
    mockConfig = {
      providers: [
        { provider_id: 'a', vendor: 'a', label: 'ProviderA', base_url: 'http://a/v1', api_key: 'sk-a', model_ids: {}, models: ['a-model'] },
        { provider_id: 'b', vendor: 'b', label: 'ProviderB', base_url: 'http://b/v1', api_key: 'sk-b', model_ids: {}, models: ['b-model'] },
      ],
    };
    const { container } = render(<ModelSection />);
    await screen.findByText('ProviderA');
    // 默认当前连接 = a（首提供方），档位候选为 a-model
    const rows = Array.from(container.querySelectorAll('[data-ui="provider_row"]')) as HTMLElement[];
    expect(rows[0].dataset.active).toBe('true');
    const initialToggle = container.querySelector('[data-ui="tier_model_toggle_router"]') as HTMLElement;
    await user.click(initialToggle);
    expect(await screen.findByText('a-model')).toBeTruthy();
    expect(screen.queryByText('b-model')).toBeNull();
    // 点选 b → 升为当前连接（providers[0]），候选切为 b-model
    await user.click(await screen.findByText('ProviderB'));
    await vi.waitFor(() => {
      const first = container.querySelector('[data-ui="provider_row"]');
      const label = first?.textContent ?? '';
      expect(label).toContain('ProviderB');
      expect(first?.getAttribute('data-active')).toBe('true');
    });
    const routerToggle = container.querySelector('[data-ui="tier_model_toggle_router"]') as HTMLElement;
    await user.click(routerToggle);
    expect(await screen.findByText('b-model')).toBeTruthy();
    expect(screen.queryByText('a-model')).toBeNull();
  });
});
