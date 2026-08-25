/**
 * 语音与离线节测试：能力芯片 / always-on 控件 / 隐私提示 / 离线档，
 * 缺宿主回落禁用态；mock invoker 注入验证状态装载。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { VoiceSection } from '../voice_section';
import type { TauriInvoker } from '@/shared/backend/tauriBridge';

function ui(name: string): HTMLElement {
  const el = document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;
  if (!el) throw new Error(`缺 data-ui 元素: ${name}`);
  return el;
}

describe('VoiceSection', () => {
  it('缺宿主时渲染禁用态与隐私提示', () => {
    render(<VoiceSection />);
    expect(screen.getByText(/隐私提示/)).toBeTruthy();
    expect(ui('voice_cap_mic')).toBeTruthy();
    expect(screen.getByText(/宿主不可用/)).toBeTruthy();
  });

  it('always-on 监听控件可切换', () => {
    render(<VoiceSection />);
    const box = ui('voice_always_on') as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.click();
    expect((ui('voice_always_on') as HTMLInputElement).checked).toBe(true);
  });

  it('mock invoker 装载状态后显示能力可用性', async () => {
    const invoker: TauriInvoker = {
      invoke: vi.fn(async (cmd: string) => {
        if (cmd === 'voice_status') return { mic: true, stt: false, tts: true, stt_model_dir: 'x', note: '模型缺失' };
        if (cmd === 'offline_detect') {
          return { ollama: { reachable: false, url: null, models: [] }, local_embedding: { available: false, source: 'Deterministic' }, local_memory: { available: false } };
        }
        return { enabled: false, mode: 'auto', ollama_url: '', use_local_embedding: true, use_local_memory: true };
      }),
    };
    render(<VoiceSection invoker={invoker} />);
    await waitFor(() => expect(screen.getByText(/模型缺失/)).toBeTruthy());
    expect(invoker.invoke).toHaveBeenCalledWith('voice_status', {});
  });

  it('离线模式下拉可切换并触发写入', async () => {
    const put = vi.fn(async () => ({}));
    const invoker: TauriInvoker = {
      invoke: vi.fn(async (cmd: string) => {
        if (cmd === 'offline_settings_put') {
          put();
          return {};
        }
        if (cmd === 'voice_status') return { mic: false, stt: false, tts: false, note: null };
        if (cmd === 'offline_detect') {
          return { ollama: { reachable: false, url: null, models: [] }, local_embedding: { available: false, source: 'Deterministic' }, local_memory: { available: false } };
        }
        return { enabled: false, mode: 'auto', ollama_url: '', use_local_embedding: true, use_local_memory: true };
      }),
    };
    render(<VoiceSection invoker={invoker} />);
    const select = ui('offline_mode') as HTMLSelectElement;
    select.value = 'local';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(put).toHaveBeenCalled());
  });
});
