/**
 * 消息 → 条目渲染器一对一映射（取代「状态行拼接」通用行）。
 *
 * 每个 message.kind 映射到独立条目组件（高内聚、各自视觉层与语义）；
 * 未登记的 kind 渲染「未登记媒体渲染器」占位（媒体层）/ null（新事件
 * 类型未来加入时由 unknown 兜底承载）。媒体消息先经媒体渲染器白名单
 * 解析：未注册类型输出拒绝占位（不执行未声明代码）。
 */

import type { ReactNode } from 'react';

import type {
  InkDocumentMessage,
  InkImageMessage,
  InkMessage,
  InkVideoMessage,
} from '@/shared/session/types';
import { resolveMediaRenderer } from '@/renderer/mediaRegistry';
import { DeviceEntry, ErrorEntry, KnowledgeHitEntry, ReviewEventEntry, SpawnEntry, SuggestionsEntry, UnknownEntry, VettingEntry } from './misc_entries';
import { MediaRejected, assetOf } from './media_entries';
import { PlanEntry } from './plan_entry';
import { StreamingEntry, TextEntry } from './text_entry';
import { ThinkingEntry } from './thinking_entry';
import { ToolEntry } from './tool_entry';
import { ChartEntry } from './chart_entry';

export type MessageHoverAction =
  | { kind: 'resend'; message: Extract<InkMessage, { kind: 'text' }> }
  | { kind: 'branch'; message: Extract<InkMessage, { kind: 'text' }> };

export interface MessageEntryContext {
  /** 流式绘制节流间隔（0 = 直绘，测试用） */
  throttleMs: number;
  /** 最新一条运行中消息的呼吸点开关 */
  live: boolean;
  /** hover 操作（编辑重发/由此分支 → 悬浮窗） */
  onOpenAction?: (action: MessageHoverAction) => void;
  /** 图表导出回调（宿主接线；缺省走锚点下载） */
  onExportChart?: (svg: string, spec: import('@/shared/charts/chart_spec').ChartSpec) => void;
}

function MediaEntry({ message, visual }: { message: InkImageMessage | InkVideoMessage | InkDocumentMessage; visual: 'card' }) {
  const Renderer = resolveMediaRenderer(message.kind);
  void visual;
  if (!Renderer) {
    return (
      <MediaRejected
        kind={message.kind}
        reason={`未登记媒体渲染器：${message.kind}（渲染器白名单拒绝）`}
      />
    );
  }
  return (
    <div className="ink-status-card px-3.5 py-3 text-[var(--ink-font-xs)] leading-[var(--ink-lh-body)]">
      <Renderer asset={assetOf(message)} />
    </div>
  );
}

/** kind → 渲染器（一对一；未知 kind 不入表 → null = 占位拒绝）。 */
export function renderMessageEntry(message: InkMessage, context: MessageEntryContext): ReactNode {
  switch (message.kind) {
    case 'text':
      return <TextEntry message={message} onOpenAction={context.onOpenAction} />;
    case 'streaming':
      return <StreamingEntry message={message} throttleMs={context.throttleMs} />;
    case 'thinking':
      return <ThinkingEntry message={message} throttleMs={context.throttleMs} live={context.live} />;
    case 'plan':
      return <PlanEntry message={message} live={context.live} />;
    case 'tool':
      return <ToolEntry message={message} live={context.live} />;
    case 'spawn':
      return <SpawnEntry id={message.id} message={message} live={context.live} />;
    case 'device':
      return <DeviceEntry id={message.id} message={message} live={context.live} />;
    case 'knowledge_hit':
      return <KnowledgeHitEntry id={message.id} message={message} live={context.live} />;
    case 'review_card':
      return <ReviewEventEntry id={message.id} message={message} live={context.live} />;
    case 'suggestions':
      return <SuggestionsEntry id={message.id} message={message} live={context.live} />;
    case 'error':
      return <ErrorEntry id={message.id} message={message} live={context.live} />;
    case 'vetting':
      return <VettingEntry id={message.id} message={message} live={context.live} />;
    case 'image':
    case 'video':
    case 'document':
      return <MediaEntry message={message} visual="card" />;
    case 'unknown':
      return <UnknownEntry id={message.id} message={message} live={context.live} />;
    case 'chart':
      return <ChartEntry message={message} onExport={context.onExportChart} />;
    default: {
      // 闭集外的新增 kind：显式占位（上游契约扩展时经此提示补渲染器）
      return <MediaRejected kind={String((message as { kind?: string }).kind)} reason="未登记消息渲染器" />;
    }
  }
}
