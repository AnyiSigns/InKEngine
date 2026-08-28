import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  registerEventRenderers,
  EVENT_RENDERER_KEYS,
  EVENT_RENDERER_SPECS,
} from '../eventRenderers';
import {
  resetMessageRendererRegistry,
  resolveMessageRenderer,
  registerRendererKey,
  registerMessageRenderer,
  isRendererKeyAllowed,
} from '@/renderer/messageRendererRegistry';
import type { HubEvent } from '@/shared/session/channelHub';
import { getUiStateStore } from '@/shared/ui/uiStateStore';
import { DEV_MODE_KEY } from '@/shared/ui/devMode';

describe('eventRenderers', () => {
  beforeEach(() => {
    resetMessageRendererRegistry();
    vi.restoreAllMocks();
    getUiStateStore().set(DEV_MODE_KEY, true);
  });

  describe('EVENT_RENDERER_KEYS', () => {
    it('包含 end/node_start/evolution_variant/unknown', () => {
      expect(EVENT_RENDERER_KEYS).toContain('end');
      expect(EVENT_RENDERER_KEYS).toContain('node_start');
      expect(EVENT_RENDERER_KEYS).toContain('evolution_variant');
      expect(EVENT_RENDERER_KEYS).toContain('unknown');
    });
  });

  describe('EVENT_RENDERER_SPECS', () => {
    it('为每个 key 提供渲染器且声明 mini+overlay 形态', () => {
      for (const spec of EVENT_RENDERER_SPECS) {
        expect(spec.key).toBeTruthy();
        expect(typeof spec.renderer).toBe('function');
        expect(spec.forms).toContain('mini');
        expect(spec.forms).toContain('overlay');
      }
    });

    it('end 渲染器被登记', () => {
      const spec = EVENT_RENDERER_SPECS.find((s) => s.key === 'end');
      expect(spec).toBeDefined();
      expect(typeof spec!.renderer).toBe('function');
    });

    it('node_start 渲染器被登记', () => {
      const spec = EVENT_RENDERER_SPECS.find((s) => s.key === 'node_start');
      expect(spec).toBeDefined();
    });

    it('evolution_variant 渲染器被登记', () => {
      const spec = EVENT_RENDERER_SPECS.find((s) => s.key === 'evolution_variant');
      expect(spec).toBeDefined();
    });
  });

  describe('registerEventRenderers', () => {
    it('注册所有事件渲染器进白名单并绑定', () => {
      const count = registerEventRenderers();
      expect(count).toBe(EVENT_RENDERER_SPECS.length);
      for (const spec of EVENT_RENDERER_SPECS) {
        expect(isRendererKeyAllowed(spec.key)).toBe(true);
      }
    });

    it('返回注册成功数量', () => {
      const count = registerEventRenderers();
      expect(count).toBe(4);
    });

    it('注册后通过 resolveMessageRenderer 解析渲染器', () => {
      registerEventRenderers();
      for (const spec of EVENT_RENDERER_SPECS) {
        expect(resolveMessageRenderer(spec.key, 'mini')).toBe(spec.renderer);
        expect(resolveMessageRenderer(spec.key, 'overlay')).toBe(spec.renderer);
      }
    });
  });

  describe('end 事件渲染器', () => {
    it('mini 形态渲染回合结束 + 理由（截断）', () => {
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('end', 'mini')!;
      const event = {
        type: 'end' as const,
        at: Date.now(),
        payload: { reason: '任务完成：已达目标', output: 'done' },
      };
      const { container } = render(<Renderer event={event} form="mini" />);
      expect(container.querySelector('[data-ui="event_renderer_end_mini"]')).toBeTruthy();
      expect(screen.getByText('回合结束')).toBeTruthy();
      expect(screen.getByText('· 任务完成：已达目标')).toBeTruthy();
    });

    it('overlay 形态渲染完整输出', () => {
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('end', 'overlay')!;
      const longOutput = 'x'.repeat(300);
      const event = {
        type: 'end' as const,
        at: Date.now(),
        payload: { reason: '完成', output: longOutput },
      };
      const { container } = render(<Renderer event={event} form="overlay" />);
      expect(container.querySelector('[data-ui="event_renderer_end_overlay"]')).toBeTruthy();
      expect(screen.getByText('回合结束')).toBeTruthy();
    });

    it('无理由时不渲染理由行', () => {
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('end', 'overlay')!;
      const event = { type: 'end' as const, at: Date.now(), payload: {} };
      const { container } = render(<Renderer event={event} form="overlay" />);
      expect(container.querySelector('[data-ui="event_renderer_end_overlay"]')).toBeTruthy();
    });
  });

  describe('node_start 事件渲染器', () => {
    it('mini 形态渲染节点信息', () => {
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('node_start', 'mini')!;
      const event = {
        type: 'node_start' as const,
        at: Date.now(),
        payload: { node_id: 'n1', node_type: 'llm_call', label: '推理步骤' },
      };
      const { container } = render(<Renderer event={event} form="mini" />);
      expect(container.querySelector('[data-ui="event_renderer_node_start_mini"]')).toBeTruthy();
    });

    it('overlay 形态渲染节点详情', () => {
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('node_start', 'overlay')!;
      const event = {
        type: 'node_start' as const,
        at: Date.now(),
        payload: { node_id: 'n2', node_type: 'tool', label: '收集材料' },
      };
      const { container } = render(<Renderer event={event} form="overlay" />);
      expect(container.querySelector('[data-ui="event_renderer_node_start_overlay"]')).toBeTruthy();
    });
  });

  describe('evolution_variant 事件渲染器', () => {
    it('mini 形态渲染变异体摘要', () => {
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('evolution_variant', 'mini')!;
      const event = {
        type: 'evolution_variant' as const,
        at: Date.now(),
        payload: { variant_id: 'v1', status: 'accepted', based_on: 'n1' },
      };
      const { container } = render(<Renderer event={event} form="mini" />);
      expect(container.querySelector('[data-ui="event_renderer_evolution_variant_mini"]')).toBeTruthy();
    });

    it('overlay 形态渲染完整详情', () => {
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('evolution_variant', 'overlay')!;
      const event = {
        type: 'evolution_variant' as const,
        at: Date.now(),
        payload: { variant_id: 'abc123', based_on: 'parent_v0', status: 'accepted', variant_of: 'factory_x' },
      };
      const { container } = render(<Renderer event={event} form="overlay" />);
      expect(container.querySelector('[data-ui="event_renderer_evolution_variant_overlay"]')).toBeTruthy();
    });
  });

  describe('unknown 兜底渲染器', () => {
    it('mini 形态折叠 + 复制按钮', () => {
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('unknown', 'mini')!;
      const event = {
        type: 'patch_applied' as const,
        at: Date.now(),
        payload: { foo: 'bar' },
      } as unknown as HubEvent;
      const { container } = render(<Renderer event={event} form="mini" />);
      expect(container.querySelector('[data-ui="event_renderer_unknown_mini"]')).toBeTruthy();
    });

    it('overlay 形态显示复制按钮', () => {
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('unknown', 'overlay')!;
      const event = {
        type: 'patch_reverted' as const,
        at: Date.now(),
        payload: { data: 123 },
      } as unknown as HubEvent;
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      const { container } = render(<Renderer event={event} form="overlay" />);
      expect(container.querySelector('[data-ui="event_renderer_unknown_overlay"]')).toBeTruthy();

      const copyBtn = container.querySelector('[data-ui="unknown_copy"]');
      fireEvent.click(copyBtn!);
      expect(writeText).toHaveBeenCalled();
    });

    it('缺渲染器类型显示折叠兜底文本格式', () => {
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('unknown', 'mini')!;
      const event = {
        type: 'new_event_type' as never,
        at: Date.now(),
        payload: {},
      } as unknown as HubEvent;
      render(<Renderer event={event} form="mini" />);
      expect(screen.getByText('未知事件：new_event_type')).toBeTruthy();
    });

    it('非开发者模式不渲染未登记事件', () => {
      getUiStateStore().set(DEV_MODE_KEY, false);
      registerEventRenderers();
      const Renderer = resolveMessageRenderer('unknown', 'mini')!;
      const event = {
        type: 'new_event_type' as never,
        at: Date.now(),
        payload: {},
      } as unknown as HubEvent;
      const { container } = render(<Renderer event={event} form="mini" />);
      expect(container.querySelector('[data-ui="event_renderer_unknown_mini"]')).toBeNull();
      getUiStateStore().set(DEV_MODE_KEY, true);
    });
  });

  describe('动态覆盖注册', () => {
    it('重新注册覆盖已有渲染器', () => {
      registerEventRenderers();
      const original = resolveMessageRenderer('end', 'mini');
      expect(original).toBeTruthy();

      const customRenderer = () => null;
      registerMessageRenderer('end', customRenderer, ['mini', 'overlay']);
      expect(resolveMessageRenderer('end', 'mini')).toBe(customRenderer);
    });

    it('白名单键注册成功', () => {
      const ok = registerRendererKey('custom_event_test');
      expect(ok).toBe(true);
      expect(isRendererKeyAllowed('custom_event_test')).toBe(true);
    });

    it('非法键名拒绝注册', () => {
      expect(registerRendererKey('123invalid')).toBe(false);
      expect(registerRendererKey('UPPER')).toBe(false);
      expect(registerRendererKey('')).toBe(false);
    });
  });
});
