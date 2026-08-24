/**
 * 设置页扩展测试：四节（环境容器/应用能力/生长治理/安全信任）+
 * 连接/外观；推理档声明渲染（param=null 隐藏 + 提示）；推演档位；
 * 搜索 key；容器维护入口；挂载向导端到端。
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsForm } from '@/components/settings_form';

describe('四节导航 + 默认内容', () => {
  it('导航含四节 + 连接/外观/关于；默认分区 = 应用能力（模型挡位）', () => {
    render(<SettingsForm />);
    for (const label of ['环境容器', '应用能力', '生长治理', '安全信任', '连接', '外观', '关于']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByText('制片人决策')).toBeInTheDocument();
    expect(screen.getByText('主模型')).toBeInTheDocument();
  });

  it('入口含管理台/架构/界面树', () => {
    render(<SettingsForm />);
    expect(screen.getByText('管理台')).toBeInTheDocument();
    expect(screen.getByText('架构')).toBeInTheDocument();
    expect(screen.getByText('界面树')).toBeInTheDocument();
  });
});

describe('应用能力：推理强度档（按 reasoning_profile 声明渲染）', () => {
  it('param=null 的模型档隐藏控制器 + 提示', async () => {
    const user = userEvent.setup();
    render(<SettingsForm />);
    expect(screen.getByText('推演档位')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('推理模型档'), 'glm-lite');
    expect(await screen.findByText(/该模型不支持推理强度调节/)).toBeInTheDocument();
    expect(screen.queryByText('推演档位')).not.toBeInTheDocument();
    expect(screen.queryByText('全量')).not.toBeInTheDocument();
  });

  it('推演档位三选：关/轻探测/全量（param 可用模型）', async () => {
    const user = userEvent.setup();
    render(<SettingsForm />);
    expect(screen.getByText('关')).toBeInTheDocument();
    expect(screen.getByText('轻探测')).toBeInTheDocument();
    expect(screen.getByText('全量')).toBeInTheDocument();
    await user.click(screen.getByText('全量'));
    expect(document.querySelector('[data-ui="sim_tier_full"]')?.getAttribute('data-active')).toBe('true');
  });

  it('搜索 key 配置项：search_key + search_provider 可编辑', async () => {
    const user = userEvent.setup();
    render(<SettingsForm />);
    const keyInput = screen.getByLabelText('search_key');
    await user.type(keyInput, 'sk-test-123');
    expect((keyInput as HTMLInputElement).value).toBe('sk-test-123');
    await user.selectOptions(screen.getByLabelText('search_provider'), 'bocha');
    expect((screen.getByLabelText('search_provider') as HTMLSelectElement).value).toBe('bocha');
  });
});

describe('环境容器节', () => {
  it('创建前审批开关 + 镜像清单 + 孤儿清理三态反馈 + 幂等销毁二次确认', async () => {
    const user = userEvent.setup();
    render(<SettingsForm />);
    await user.click(screen.getByRole('button', { name: /环境容器/ }));
    expect(screen.getByText('创建容器前必须人工审批（fail-closed）')).toBeInTheDocument();
    expect(screen.getByLabelText('镜像清单')).toBeInTheDocument();
    await user.click(screen.getByText('清理孤儿容器'));
    expect(await screen.findByText('清理完成')).toBeInTheDocument();
    await user.click(screen.getByText('全部销毁'));
    expect(screen.getByText('确认销毁全部环境容器？')).toBeInTheDocument();
    await user.click(screen.getByText('确认'));
    expect(screen.queryByText('确认销毁全部环境容器？')).not.toBeInTheDocument();
  });
});

describe('生长治理节', () => {
  it('自动孵化开关/种子观察周期/闸门默认档/记忆窗口', async () => {
    const user = userEvent.setup();
    render(<SettingsForm />);
    await user.click(screen.getByRole('button', { name: /生长治理/ }));
    expect(screen.getByText('自动孵化观察信号（会话内静默收集，变更落位需闸门）')).toBeInTheDocument();
    await user.click(screen.getByText('L1'));
    expect(document.querySelector('[data-ui="growth_gate_L1"]')?.getAttribute('data-active')).toBe('true');
    expect(screen.getByLabelText('记忆失效窗口')).toBeInTheDocument();
  });
});

describe('安全信任节', () => {
  it('权限矩阵/默认权限档/网络策略/审计入口/导出恢复入口', async () => {
    const user = userEvent.setup();
    render(<SettingsForm />);
    await user.click(screen.getByRole('button', { name: /安全信任/ }));
    expect(screen.getByText('权限矩阵（kind → L0/L1/L2）')).toBeInTheDocument();
    expect(screen.getByText('默认权限档')).toBeInTheDocument();
    expect(screen.getByText('网络策略')).toBeInTheDocument();
    await user.type(screen.getByLabelText('网络域名白名单'), 'docs.example.org');
    expect((screen.getByLabelText('网络域名白名单') as HTMLInputElement).value).toBe('docs.example.org');
    await user.click(screen.getByText('导出审计日志'));
    expect(await screen.findByText('审计日志已导出')).toBeInTheDocument();
    expect(screen.getByText('一键导出')).toBeInTheDocument();
    expect(screen.getByText('恢复向导')).toBeInTheDocument();
    expect(screen.getByText(/导出 = 数据目录一键打包/)).toBeInTheDocument();
  });
});

describe('连接节：挂载向导悬浮窗端到端', () => {
  it('向导四步完成挂载 → 已挂载清单即时同步', async () => {
    const user = userEvent.setup();
    render(<SettingsForm />);
    await user.click(screen.getByRole('button', { name: /连接/ }));
    expect(screen.getByText('mcp_market 市场（出厂零预挂，一键挂载走 vetting → 观察 → L2 审批转正）')).toBeInTheDocument();
    await user.click(screen.getByText('挂载向导'));
    expect(screen.getByRole('dialog', { name: '挂载向导' })).toBeInTheDocument();
    await user.click(document.querySelector('[data-ui="wizard_market_web_search"]') as HTMLElement);
    await user.click(document.querySelector('[data-ui="wizard_next_0"]') as HTMLElement);
    await user.click(document.querySelector('[data-ui="wizard_next_1"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-ui="wizard_next_2"]')).not.toBeNull());
    await user.click(document.querySelector('[data-ui="wizard_next_2"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-ui="wizard_next_3"]')).not.toBeNull());
    await user.click(document.querySelector('[data-ui="wizard_next_3"]') as HTMLElement);
    await screen.findByText('已挂载：web_search（可回退）');
  });
});
