/**
 * 事件渲染器注册（W4.5）：把特定事件类型映射到渲染组件。
 *
 * 渲染器键白名单：end / node_start / evolution_variant 三类事件类型
 * 获得专属渲染器；未知事件类型折叠兜底 + 复制按钮。
 *
 * 通过 messageRendererRegistry 登记进白名单并绑定渲染器。
 * 注册键非法时白名单拒绝、绑定 fail-closed（防开放通道被滥用）。
 *
 * 渲染器形态：mini（内联紧凑 / 状态气泡）/ overlay（弹层展开）。
 * 绑定协议 events.<type> 通道，负载原样投递，组件消费声明的事件面。
 */

import { useState } from 'react';
import { CheckCircle, Copy, ChevronDown, ChevronRight, Code } from 'lucide-react';

import {
  registerRendererKey,
  registerMessageRenderer,
  type MessageRenderer,
  type MessageRendererForm,
  type MessageRendererProps,
} from '@/renderer/messageRendererRegistry';
import type { HubEvent } from '@/shared/session/channelHub';
import { logger } from '@/shared/logger';
import { useDevMode } from '@/shared/ui/devMode';

/** 事件渲染器键（W4.5）：end / node_start / evolution_variant + unknown 兜底。 */
export const EVENT_RENDERER_KEYS = ['end', 'node_start', 'evolution_variant', 'unknown'] as const;

/**
 * 事件渲染器描述（EventTypeSpec.renderer 映射）：
 * 每个事件类型 → 渲染器组件 + 支持形态。
 */
export interface EventRendererSpec {
  key: string;
  renderer: MessageRenderer;
  forms: MessageRendererForm[];
}

/** 回合结束事件渲染器（mini 内联状态气泡）。 */
function EndEventRenderer({ event, form }: MessageRendererProps) {
  const [devMode] = useDevMode();
  const payload = (event as HubEvent | undefined)?.payload ?? {};
  const reason = typeof payload.reason === 'string' ? payload.reason : '';
  const output = typeof payload.output === 'string' ? payload.output : '';
  const isOverlay = form === 'overlay';

  if (isOverlay) {
    return (
      <div className="p-2" data-ui="event_renderer_end_overlay">
        <div className="flex items-center gap-1.5">
          <CheckCircle size={14} strokeWidth={1.5} className="ink-text-muted" aria-hidden />
          <span className="text-[12px] font-medium">回合结束</span>
        </div>
        {reason ? <div className="mt-1.5 text-[11px] leading-relaxed ink-text-muted">{reason}</div> : null}
        {devMode && output ? (
          <div className="mt-1.5 rounded-md border ink-border bg-[var(--ink-bg-elevated)] p-2 font-mono text-[10px] ink-text-faint">
            {output.slice(0, 200)}
            {output.length > 200 ? '…' : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1 text-[10px] ink-text-muted" data-ui="event_renderer_end_mini">
      <CheckCircle size={10} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
      <span>回合结束</span>
      {reason ? <span className="truncate">· {reason.slice(0, 40)}</span> : null}
    </div>
  );
}

/** 节点启动事件渲染器（agent_graph 节点开始）。 */
function NodeStartEventRenderer({ event, form }: MessageRendererProps) {
  const [devMode] = useDevMode();
  const payload = (event as HubEvent | undefined)?.payload ?? {};
  const nodeId = typeof payload.node_id === 'string' ? payload.node_id : '';
  const nodeType = typeof payload.node_type === 'string' ? payload.node_type : '';
  const label = typeof payload.label === 'string' ? payload.label : '';
  const isOverlay = form === 'overlay';

  const display = label || nodeId || nodeType || '未知节点';

  if (isOverlay) {
    return (
      <div className="p-2" data-ui="event_renderer_node_start_overlay">
        <div className="flex items-center gap-1.5">
          <span className="ink-icon-chip h-5 w-5">
            <Code size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          </span>
          <span className="text-[12px] font-medium">节点开始</span>
          {devMode && nodeId ? <span className="font-mono text-[10px] ink-text-faint">#{nodeId}</span> : null}
        </div>
        <div className="mt-1 text-[11px] ink-text-muted">
          {display}
          {devMode && nodeType ? <span className="ml-1.5 rounded px-1 py-px text-[9px] ink-elevated">{nodeType}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1 text-[10px] ink-text-muted" data-ui="event_renderer_node_start_mini">
      <span className="font-mono">▶ {display.slice(0, 30)}</span>
    </div>
  );
}

/** 进化变异体事件渲染器（evolution_variant）。 */
function EvolutionVariantEventRenderer({ event, form }: MessageRendererProps) {
  const payload = (event as HubEvent | undefined)?.payload ?? {};
  const variantId = typeof payload.variant_id === 'string' ? payload.variant_id : '';
  const basedOn = typeof payload.based_on === 'string' ? payload.based_on : '';
  const status = typeof payload.status === 'string' ? payload.status : '';
  const variantOf = typeof payload.variant_of === 'string' ? payload.variant_of : '';
  const isOverlay = form === 'overlay';

  if (isOverlay) {
    return (
      <div className="p-2" data-ui="event_renderer_evolution_variant_overlay">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium">进化变异体</span>
          <span className="font-mono text-[10px] ink-text-faint">#{variantId || '未命名'}</span>
        </div>
        {basedOn ? (
          <div className="mt-1 text-[10px] ink-text-faint">
            基体：<span className="font-mono">{basedOn}</span>
          </div>
        ) : null}
        {variantOf ? (
          <div className="mt-0.5 text-[10px] ink-text-faint">
            关联：<span className="font-mono">{variantOf}</span>
          </div>
        ) : null}
        {status ? (
          <div className="mt-1">
            <span className="ink-chip py-px text-[9px]">{status}</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1 text-[10px] ink-text-muted" data-ui="event_renderer_evolution_variant_mini">
      <span>▲ 进化变异体</span>
      {variantId ? <span className="font-mono">#{variantId.slice(0, 8)}</span> : null}
      {status ? <span className="ink-chip py-px text-[9px]">{status}</span> : null}
    </div>
  );
}

/** 未知事件类型兜底渲染器（折叠 + 复制按钮；仅开发者模式渲染）。 */
function UnknownEventRenderer({ event, form }: MessageRendererProps) {
  const [devMode] = useDevMode();
  const payload = (event as HubEvent | undefined)?.payload ?? {};
  const eventType = (event as HubEvent | undefined)?.type ?? 'unknown';
  const [expanded, setExpanded] = useState(false);

  const rawJson = JSON.stringify({ type: eventType, payload }, null, 2);
  const isOverlay = form === 'overlay';

  // 未登记事件不对普通用户展示（原始负载属诊断信息）
  if (!devMode) return null;

  if (isOverlay) {
    return (
      <div className="p-2" data-ui="event_renderer_unknown_overlay">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
          <Code size={14} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          <span className="font-medium">未知事件</span>
          <span className="font-mono ink-text-faint">{eventType}</span>
        </div>
        <button
          type="button"
          data-ui="unknown_copy"
          onClick={() => {
            void navigator.clipboard.writeText(rawJson);
          }}
          className="flex items-center gap-1 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer"
        >
          <Copy size={10} strokeWidth={1.5} aria-hidden />
          复制原始负载
        </button>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1 text-[10px] ink-text-faint" data-ui="event_renderer_unknown_mini">
      <Code size={10} strokeWidth={1.6} aria-hidden />
      <span>未知事件：{eventType}</span>
      <button
        type="button"
        data-ui="unknown_toggle"
        onClick={() => setExpanded((v) => !v)}
        className="cursor-pointer hover:text-[var(--ink-text-base)]"
      >
        {expanded ? <ChevronDown size={10} strokeWidth={1.6} /> : <ChevronRight size={10} strokeWidth={1.6} />}
      </button>
      {expanded ? (
        <div className="fixed inset-0 z-[var(--ink-z-floater)] flex items-center justify-center bg-black/40" data-ui="unknown_detail">
          <div className="max-w-lg rounded-lg border bg-[var(--ink-bg-surface)] p-4 shadow-[var(--ink-shadow-pop)]">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-medium">未知事件负载</span>
              <button
                type="button"
                data-ui="unknown_copy_detail"
                onClick={() => {
                  void navigator.clipboard.writeText(rawJson);
                }}
                className="flex items-center gap-1 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer"
              >
                <Copy size={10} strokeWidth={1.5} aria-hidden /> 复制
              </button>
            </div>
            <pre className="max-h-80 overflow-y-auto font-mono text-[9px] ink-text-faint">
              {rawJson}
            </pre>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                data-ui="unknown_close"
                onClick={() => setExpanded(false)}
                className="text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 事件渲染器注册表（W4.5）：EventTypeSpec.renderer 映射。 */
export const EVENT_RENDERER_SPECS: EventRendererSpec[] = [
  { key: 'end', renderer: EndEventRenderer, forms: ['mini', 'overlay'] },
  { key: 'node_start', renderer: NodeStartEventRenderer, forms: ['mini', 'overlay'] },
  { key: 'evolution_variant', renderer: EvolutionVariantEventRenderer, forms: ['mini', 'overlay'] },
  { key: 'unknown', renderer: UnknownEventRenderer, forms: ['mini', 'overlay'] },
];

/**
 * 注册事件渲染器（W4.5）：登记白名单键 + 绑定渲染器。
 * fail-closed：键不在白名单 / 渲染器缺失 → 拒绝注册。
 * 幂等：重复注册同名覆盖。
 */
export function registerEventRenderers(): number {
  let count = 0;
  for (const spec of EVENT_RENDERER_SPECS) {
    const keyOk = registerRendererKey(spec.key);
    if (!keyOk) {
      logger.warn('app', `渲染器键不合法，跳过注册: ${spec.key}`);
      continue;
    }
    const ok = registerMessageRenderer(spec.key, spec.renderer as MessageRenderer, spec.forms);
    if (ok) {
      count += 1;
    } else {
      logger.warn('app', `渲染器注册失败: ${spec.key}`);
    }
  }
  logger.info('app', '事件渲染器已注册', { count });
  return count;
}
