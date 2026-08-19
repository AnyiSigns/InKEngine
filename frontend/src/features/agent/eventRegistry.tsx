/**
 * 事件注册表中心（插件式：AI 演化生成的新事件类型经注册表同构加入）。
 *
 * 双注册表：
 * - 渲染注册表：事件类型 → 消息渲染组件（与引擎 EventTypeSpec 的
 *   renderer 名对应，如 thinking_start → ThinkingRow）；
 * - 处理注册表：事件类型 → SSE 流式处理器（建卡/更新/收尾）；
 * 两处均为 Map + register——插件注册即接入，未注册类型走折叠兜底
 * （显示原始 JSON，回放不崩——直播 = 回放语义在前端落位）。
 */

import { useAgentStore } from './agentStore';
import type { MessageItemProps } from '@/components/agent/MessageItem';
import type { SSEEvent } from '@/shared/api/types';

export type MessageRenderer = (props: MessageItemProps) => React.ReactNode;

const renderers = new Map<string, MessageRenderer>();

/** 注册事件渲染器（同名重复注册覆盖——内置基线优先，插件后可接管）。 */
export function registerMessageRenderer(type: string, renderer: MessageRenderer): void {
  renderers.set(type, renderer);
}

/** 按事件类型取渲染器（未注册 = undefined，调用方走兜底路径）。 */
export function messageRenderer(type: string | undefined): MessageRenderer | undefined {
  return type ? renderers.get(type) : undefined;
}

/** 已注册的事件渲染类型（诊断/审计视图）。 */
export function registeredRenderers(): string[] {
  return [...renderers.keys()];
}

/** SSE 处理器注入的依赖集合（agentStore 写入 + 回合级 refs）。 */
export interface SSEHandlerContext {
  upsertStep: Store['upsertStep'];
  appendReplyToken: Store['appendReplyToken'];
  addMessage: Store['addMessage'];
  setPendingReview: Store['setPendingReview'];
  setActiveRoundId: Store['setActiveRoundId'];
  commitStreaming: Store['commitStreaming'];
  flushTokens: () => void;
  scheduleToken: (stepId: string, roundId: string, token: string) => void;
  scheduleNodeOutput: (stepId: string, roundId: string, token: string) => void;
  flushNodeOutputs: () => void;
  replyRef: { current: string };
  /** 工具分类回调（大纲类工具触发大纲刷新等旁路逻辑） */
  onToolCategory?: (category: string) => void;
}

type Store = ReturnType<typeof useAgentStore.getState>;

export type EventHandler = (ctx: SSEHandlerContext, event: SSEEvent) => void;

const handlers = new Map<string, EventHandler>();

/** 注册事件处理器（同名覆盖——插件可接管内置类型的分发）。 */
export function registerEventHandler(type: string, handler: EventHandler): void {
  handlers.set(type, handler);
}

/** 按事件类型取处理器（未注册 = undefined，调用方走折叠兜底）。 */
export function eventHandler(type: string): EventHandler | undefined {
  return handlers.get(type);
}

/** 已注册的事件处理类型（诊断/审计视图）。 */
export function registeredEventHandlers(): string[] {
  return [...handlers.keys()];
}

/** 未知事件折叠兜底卡：展示事件原始 JSON（不崩、可审计、可回放）。 */
export function FoldRow({ data }: { data: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] rounded-md border border-dashed border-foreground/15 bg-foreground/[0.02] px-3 py-2">
        <div className="mb-1 text-[9px] uppercase tracking-wider text-foreground/25">
          未注册事件
        </div>
        <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-foreground/45">
          {data}
        </pre>
      </div>
    </div>
  );
}
