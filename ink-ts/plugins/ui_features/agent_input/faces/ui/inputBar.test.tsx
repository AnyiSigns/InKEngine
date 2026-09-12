import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InputBar } from './InputBar';
import type { ModelArchiveSnapshot } from '@/shared/backend/backendAdapter';

describe('InputBar', () => {
  it('allows typing and sending without configured models', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />);
    const textarea = screen.getByPlaceholderText('给智能体发消息') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('hello', [], undefined);
  });

  it('shows model chip when model selected', () => {
    const models: ModelArchiveSnapshot = { archives: [{ model_id: 'kimi-k2', context_window: 128 * 1024, multimodal: true }] };
    render(<InputBar disabled={false} streaming={false} models={models} onSend={() => {}} onAbort={() => {}} onAttachments={() => {}} />);
    expect(screen.getByText('kimi-k2')).toBeTruthy();
    expect(screen.getByText('多模态')).toBeTruthy();
  });

  it('effort 模型：档位原样展示（off/low/medium/high）并携带所选档位', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'qwen3-max', reasoning: true, reasoning_style: 'effort', reasoning_efforts: ['low', 'high'] }] }} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '推理档位' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'high' }));
    fireEvent.change(screen.getByPlaceholderText('给智能体发消息'), { target: { value: 'hi' } });
    fireEvent.keyDown(screen.getByPlaceholderText('给智能体发消息'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('hi', [], { model_id: 'qwen3-max', reasoning_effort: 'high' });
  });

  it('未声明推理能力（v4flash 类）不显示推理控件', () => {
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'deepseek-chat' }] }} onSend={() => {}} onAbort={() => {}} onAttachments={() => {}} />);
    expect(screen.queryByRole('button', { name: '推理档位' })).toBeNull();
  });

  it('reasoning_style=none（固定推理，如 deepseek 系）不显示推理控件', () => {
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'deepseek-v4', reasoning: true, reasoning_style: 'none' }] }} onSend={() => {}} onAbort={() => {}} onAttachments={() => {}} />);
    expect(screen.queryByRole('button', { name: '推理档位' })).toBeNull();
  });

  it('boolean 模型：显示开关，选开携带 enable_thinking:true', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'qwen3', reasoning: true, reasoning_style: 'boolean' }] }} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '推理档位' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '开' }));
    fireEvent.change(screen.getByPlaceholderText('给智能体发消息'), { target: { value: 'hi' } });
    fireEvent.keyDown(screen.getByPlaceholderText('给智能体发消息'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('hi', [], { model_id: 'qwen3', enable_thinking: true });
  });

  it('budget 模型：显示预算下拉，选 8 档携带 thinking_budget:8192', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'claude-4', reasoning: true, reasoning_style: 'budget', reasoning_budget: [4096, 8192, 16384] }] }} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '推理档位' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '8k' }));
    fireEvent.change(screen.getByPlaceholderText('给智能体发消息'), { target: { value: 'hi' } });
    fireEvent.keyDown(screen.getByPlaceholderText('给智能体发消息'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('hi', [], { model_id: 'claude-4', thinking_budget: 8192 });
  });

  it('effort 未声明 specifics 时显示引擎标准四档（off/low/medium/high）+ auto，原样不翻译', () => {
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'm-effort', reasoning: true, reasoning_style: 'effort' }] }} onSend={() => {}} onAbort={() => {}} onAttachments={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '推理档位' }));
    expect(screen.getByRole('menuitem', { name: 'off' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'low' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'medium' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'high' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '自动' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '关' })).toBeNull();
  });

  it('budget 无 reasoning_budget（未声明档位）不显示推理控件', () => {
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'm-budget', reasoning: true, reasoning_style: 'budget' }] }} onSend={() => {}} onAbort={() => {}} onAttachments={() => {}} />);
    expect(screen.queryByRole('button', { name: '推理档位' })).toBeNull();
  });

  it('sends on Enter', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'm1' }] }} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('给智能体发消息'), { target: { value: 'hello' } });
    fireEvent.keyDown(screen.getByPlaceholderText('给智能体发消息'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('hello', [], { model_id: 'm1' });
  });

  it('回合档位切换已取消：无标准/组装下拉，发送恒为组装', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />);
    expect(screen.queryByRole('button', { name: /标准|组装/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('给智能体发消息'), { target: { value: 'ok' } });
    fireEvent.keyDown(screen.getByPlaceholderText('给智能体发消息'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('ok', [], undefined);
  });

  it('弹卡档位筛选框与模型筛选框并列：默认 review 展示，选 auto 触发宿主导入，点当前档不触发', () => {
    const onChange = vi.fn();
    render(
      <InputBar
        disabled={false}
        streaming={false}
        models={{ archives: [{ model_id: 'm1' }] }}
        approvalPose="review"
        onApprovalPoseChange={onChange}
        onSend={() => {}}
        onAbort={() => {}}
        onAttachments={() => {}}
      />,
    );
    // 弹卡档位 = 筛选框形态（非胶囊分组），与模型筛选框同排
    const poseFilter = screen.getByRole('button', { name: '弹卡档位' });
    const modelFilter = screen.getByRole('button', { name: '模型/推理档位' });
    expect(poseFilter).toBeTruthy();
    expect(modelFilter).toBeTruthy();
    expect(poseFilter.textContent).toContain('询问');
    fireEvent.click(poseFilter);
    fireEvent.click(screen.getByRole('option', { name: '自动' }));
    expect(onChange).toHaveBeenCalledWith('auto');
    // 重开弹层点当前档（询问）不触发
    fireEvent.click(screen.getByRole('button', { name: '弹卡档位' }));
    fireEvent.click(screen.getByRole('option', { name: /^询问/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

/**
 * 输入区图像上传交互（W8B：附件选取 → 随消息走）。
 *
 * 测什么：隐藏 file input 选图 → data URL 附件资产入待发清单（onAttachments
 * 带出、胶囊展示文件名）→ 发送时 onSend 携图像附件（kind=image + data: URL）；
 * 移除钮撤下单个附件；纯文本发送附件恒为空数组（既有行为零漂移）。
 */
async function pickImageFile(container: HTMLElement, file: File, label: string) {
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(file, 'name', { value: label });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
}

describe('图像附件上传面', () => {
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'x.png', { type: 'image/png' });

  it('选图 → 附件进待发清单并带出 onAttachments，发送携带 data URL 图像附件', async () => {
    const onSend = vi.fn();
    const onAttachments = vi.fn();
    const { container } = render(
      <InputBar disabled={false} streaming={false} onSend={onSend} onAbort={() => {}} onAttachments={onAttachments} />,
    );
    await pickImageFile(container, png(), 'shot.png');
    expect(onAttachments).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'image', name: 'shot.png', mime: 'image/png' }),
    ]);
    const recorded = onAttachments.mock.calls[0]![0] as Array<{ url: string }>;
    expect(recorded[0]!.url.startsWith('data:image/png;base64,')).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('给智能体发消息'), { target: { value: '看看这张图' } });
    fireEvent.keyDown(screen.getByPlaceholderText('给智能体发消息'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith(
      '看看这张图',
      [expect.objectContaining({ kind: 'image', name: 'shot.png' })],
      undefined,
    );
  });

  it('移除钮撤下附件：误选后可撤回，发送回到纯文本零附件', async () => {
    const onSend = vi.fn();
    const { container } = render(
      <InputBar disabled={false} streaming={false} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />,
    );
    await pickImageFile(container, png(), 'oops.png');
    fireEvent.click(screen.getByRole('button', { name: '移除附件' }));
    await waitFor(() => expect(screen.queryByText('oops.png')).toBeNull());
    fireEvent.change(screen.getByPlaceholderText('给智能体发消息'), { target: { value: '纯文本' } });
    fireEvent.keyDown(screen.getByPlaceholderText('给智能体发消息'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('纯文本', [], undefined);
  });
});
