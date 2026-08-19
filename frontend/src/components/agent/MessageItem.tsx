
/**
 * 消息渲染（协议 v2）：type → 组件渲染注册表。
 *
 * 统一 StepRow 视觉语言：图标/状态点 + 短文案 + 右侧指示器（✓/✗/旋转/等待）。
 * - 思考/规划卡：运行中自动展开内容、完成自动收起（历史回放一律收起），
 *   「已参考记忆」折叠区挂在卡内；
 * - 工具卡：单行状态（运行/等待审核/完成/失败），不展开；
 * - 节点卡：行内进度 N/M + 点击展开正文；
 * - 审核卡：ReviewCard（历史回放 live:false 只读）；
 * - 消息 hover 操作栏（右下角 icon 化）：复制 / 编辑（user 消息行内编辑原位展开）；
 * - 未注册事件类型走折叠兜底卡（显示原始 JSON，回放不崩）。
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, FileText, Pencil, X, Check } from 'lucide-react';
import { cn } from '@/shared/cn';
import { PROGRESS_STEP_LABELS } from '@/features/agent/agentEvents';
import { FoldRow, registerMessageRenderer, messageRenderer } from '@/features/agent/eventRegistry';
import { ReviewCard } from './ReviewCard';
import type { AgentStepMessage } from '@/features/agent/agentStore';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children: c }) => <p className="my-1 first:mt-0 last:mb-0">{c}</p>,
        strong: ({ children: c }) => <strong className="font-semibold">{c}</strong>,
        em: ({ children: c }) => <em className="italic">{c}</em>,
        ul: ({ children: c }) => <ul className="list-disc pl-4 my-1 space-y-0.5">{c}</ul>,
        ol: ({ children: c }) => <ol className="list-decimal pl-4 my-1 space-y-0.5">{c}</ol>,
        li: ({ children: c }) => <li>{c}</li>,
        code: ({ children: c, className: cls }) => {
          const isInline = !cls;
          return isInline ? (
            <code className="px-1 py-0.5 bg-foreground/10 text-[12px]">{c}</code>
          ) : (
            <code className="block my-1 p-2 bg-foreground/5 text-[12px] overflow-x-auto whitespace-pre-wrap">{c}</code>
          );
        },
        pre: ({ children: c }) => <pre className="my-1">{c}</pre>,
        blockquote: ({ children: c }) => (
          <blockquote className="border-l-2 border-foreground/15 pl-3 my-1 italic text-muted-foreground/80">{c}</blockquote>
        ),
        hr: () => <hr className="my-2 border-foreground/10" />,
        h1: ({ children: c }) => <h1 className="text-[15px] font-semibold my-2">{c}</h1>,
        h2: ({ children: c }) => <h2 className="text-[14px] font-semibold my-1.5">{c}</h2>,
        h3: ({ children: c }) => <h3 className="text-[13px] font-semibold my-1">{c}</h3>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export function safeParseJSON(str: string): unknown {
  try { return JSON.parse(str); } catch { return null; }
}

export interface MessageItemProps {
  msg: AgentStepMessage;
  index: number;
  agentStreaming: boolean;
  onReviewAction: (action: 'accept' | 'retry' | 'edit' | 'terminate', editedContent?: string, chapterId?: number) => void;
  onCopy: (text: string) => void;
  /** user 消息行内编辑确认：有 roundId 的历史消息走 T6 重新生成；否则发送新回合 */
  onInlineEditSend: (text: string, roundId?: string) => void;
  onUnlockAndRetry: (retryMessage: string) => void;
}

/** 状态点颜色（统一视觉：运行=琥珀、完成=绿、失败=红、等待=琥珀）。 */
function StatusDot({ tone }: { tone: 'running' | 'done' | 'failed' | 'pending' }) {
  const cls =
    tone === 'done' ? 'bg-emerald-500/60'
    : tone === 'failed' ? 'bg-red-500/60'
    : 'bg-amber-400/70';
  return <span className={cn('w-1.5 h-1.5 rounded-full inline-block shrink-0', cls)} />;
}

function Spinner() {
  return (
    <span className="ml-auto inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground/70" />
  );
}

/** 状态行通用骨架（icon/状态点 + 文案 + 右侧指示器）。 */
function StatusRow({ tone, label, right, onToggle }: {
  tone: 'running' | 'done' | 'failed' | 'pending';
  label: string;
  right?: React.ReactNode;
  onToggle?: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left',
        onToggle ? 'cursor-pointer hover:bg-muted/40' : 'cursor-default',
      )}
    >
      <StatusDot tone={tone} />
      <span className={cn(tone === 'running' && 'thinking-shimmer-text', tone === 'failed' && 'text-red-500/70', tone === 'done' && 'text-foreground/70', tone === 'pending' && 'text-amber-500/90 font-medium')}>
        {label}
      </span>
      {right}
      {onToggle && (
        <ChevronDown size={11} strokeWidth={1.5} className="ml-auto shrink-0 text-foreground/30" />
      )}
    </div>
  );
}

/** 状态卡外壳（状态行 + 可展开内容区）。 */
function StatusCard({ children, tone, label, right, expanded, onToggle }: {
  children?: React.ReactNode;
  tone: 'running' | 'done' | 'failed' | 'pending';
  label: string;
  right?: React.ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="flex justify-start">
      <div className="w-full rounded-md border border-foreground/10 bg-foreground/[0.03] overflow-hidden">
        <StatusRow tone={tone} label={label} right={right} onToggle={onToggle} />
        {expanded && children}
      </div>
    </div>
  );
}

/** 状态消息气泡：由状态行控制显示/消失的独立内容区。 */
function StatusBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2.5 flex justify-start">
      <div className="w-full rounded-md border border-foreground/[0.06] bg-foreground/[0.04] px-3 py-2 text-[12px] leading-relaxed text-foreground/70">
        {children}
      </div>
    </div>
  );
}

/** 状态感知展开：运行中自动展开、完成自动收起（历史回放一律收起）。
 *  纯派生实现（无 effect）：用户手动切换后转入用户控制。 */
function useStateAwareExpand(status: string | undefined): [boolean, () => void] {
  const [userToggled, setUserToggled] = useState(false);
  const [userExpanded, setUserExpanded] = useState(false);
  const expanded = userToggled ? userExpanded : status === 'running';
  const toggle = () => {
    setUserToggled(true);
    setUserExpanded((e) => !e);
  };
  return [expanded, toggle];
}

/** 记忆折叠区（思考/规划卡「已参考记忆」）。 */
function MemoriesFold({ memories }: { memories?: Array<{ id: unknown; title: string; snippet: string }> }) {
  const items = memories?.filter((m) => m.title || m.snippet) ?? [];
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="mt-2.5 flex justify-start">
      <div className="w-full rounded-md border border-foreground/[0.06] bg-foreground/[0.04] overflow-hidden">
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] bg-transparent border-none cursor-pointer hover:bg-muted/40 text-left"
        >
          <span className="text-foreground/50">已参考记忆</span>
          <span className="text-[10px] text-foreground/30">{items.length} 条</span>
          <ChevronDown size={11} strokeWidth={1.5} className={cn('ml-auto shrink-0 text-foreground/30 transition-transform', open && 'rotate-180')} />
        </button>
        {open && (
          <div className="px-3 pb-2 text-[11px] leading-relaxed text-foreground/60">
            {items.map((m, i) => (
              <div key={`${String(m.id)}-${i}`} className="py-1">
                <div className="font-medium text-foreground/70">{m.title || '（未命名记忆）'}</div>
                {m.snippet && <div className="truncate text-foreground/40">{m.snippet}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 思考卡（路由决策推理）：状态行 + 内容气泡（状态感知展开）+ 记忆折叠区。 */
function ThinkingRow({ msg }: { msg: Extract<AgentStepMessage, { type: 'thinking' }> }) {
  const running = msg.status !== 'completed';
  const [expanded, toggle] = useStateAwareExpand(msg.status);
  return (
    <>
      <StatusCard
        tone={running ? 'running' : 'done'}
        label={running ? '思考中' : '思考完成'}
        right={running ? <Spinner /> : null}
        expanded={expanded && Boolean(msg.content)}
        onToggle={toggle}
      >
        {msg.content && (
          <div className="px-3 pb-2">
            <div className="rounded-md border border-foreground/[0.06] bg-foreground/[0.04] px-3 py-2 text-[12px] leading-relaxed text-foreground/70">
              <MarkdownContent>{msg.content}</MarkdownContent>
            </div>
          </div>
        )}
      </StatusCard>
      <MemoriesFold memories={msg.memories} />
    </>
  );
}

/** 规划卡（域监督者）：与思考卡同构。 */
function PlanRow({ msg }: { msg: Extract<AgentStepMessage, { type: 'plan' }> }) {
  const running = msg.status !== 'completed';
  const [expanded, toggle] = useStateAwareExpand(msg.status);
  return (
    <>
      <StatusCard
        tone={running ? 'running' : 'done'}
        label={running ? '域内规划中' : '域内规划完成'}
        right={running ? <Spinner /> : null}
        expanded={expanded && Boolean(msg.content)}
        onToggle={toggle}
      >
        {msg.content && (
          <div className="px-3 pb-2">
            <div className="rounded-md border border-foreground/[0.06] bg-foreground/[0.04] px-3 py-2 text-[12px] leading-relaxed text-foreground/70">
              <MarkdownContent>{msg.content}</MarkdownContent>
            </div>
          </div>
        )}
      </StatusCard>
      <MemoriesFold memories={msg.memories} />
    </>
  );
}

/** 工具卡：单行状态（运行/等待审核/完成/失败）。 */
function ToolRow({ msg }: { msg: Extract<AgentStepMessage, { type: 'tool' }> }) {
  const running = msg.toolStatus === 'running';
  const pending = msg.toolStatus === 'pending';
  const failed = msg.toolStatus === 'error' || msg.toolSuccess === false;
  const categoryLabel = msg.category ? PROGRESS_STEP_LABELS[msg.category] || msg.category : '';
  const copy = categoryLabel
    ? {
        running: `使用${categoryLabel}工具中`,
        done: `${categoryLabel}工具已完成`,
        failed: `${categoryLabel}工具执行失败`,
      }
    : { running: '请求外援中', done: '外援已找到', failed: '工具执行失败' };
  const tone = pending ? 'pending' : running ? 'running' : failed ? 'failed' : 'done';
  return (
    <StatusCard
      tone={tone}
      label={pending ? '等待审核确认' : running ? copy.running : failed ? copy.failed : copy.done}
      right={pending ? <span className="ml-auto text-amber-500/70">●</span> : running ? <Spinner /> : failed ? <span className="ml-auto text-destructive/70">✗</span> : <span className="ml-auto text-foreground/70">✓</span>}
    />
  );
}

/** 节点卡：状态行 + 行内进度 + 展开正文。 */
function NodeRow({ msg }: { msg: Extract<AgentStepMessage, { type: 'node' }> }) {
  const running = msg.nodeStatus === 'running';
  const failed = msg.nodeStatus === 'failed';
  const aborted = msg.nodeStatus === 'aborted';
  const progress = msg.progress;
  const progressText = progress && progress.total > 0
    ? `${PROGRESS_STEP_LABELS[progress.step] || progress.label || '任务执行'} ${progress.n}/${progress.total}${progress.label ? `：${progress.label}` : ''}`
    : '';
  const [expanded, toggle] = useStateAwareExpand(running ? 'running' : 'completed');
  const showBubble = expanded && Boolean(msg.content || (failed && msg.reason));
  const tone = running ? 'running' : failed ? 'failed' : aborted ? 'pending' : 'done';
  const label = msg.label || msg.nodeId || '任务节点';
  return (
    <>
      <StatusCard
        tone={tone}
        label={label}
        right={
          running ? <Spinner /> : aborted ? <span className="ml-auto text-foreground/50">已停止</span>
          : failed ? <span className="ml-auto text-red-500/60">✗ 失败</span>
          : <span className="ml-auto text-foreground/60">✓ 完成</span>
        }
        onToggle={toggle}
      >
        {progressText && <div className="px-3 pb-1.5 text-[10px] text-foreground/50 tabular-nums">{progressText}</div>}
      </StatusCard>
      {showBubble && (
        <StatusBubble>
          {failed && msg.reason && (
            <div className="mb-1 text-[10px] text-red-500/60">失败原因：{msg.reason}</div>
          )}
          {msg.content && <MarkdownContent>{msg.content}</MarkdownContent>}
        </StatusBubble>
      )}
    </>
  );
}

/** 错误消息：附带「重试」按钮（503 锁冲突时显示「解除占用并重试」）。 */
function ErrorRow({ msg, onUnlockAndRetry }: {
  msg: Extract<AgentStepMessage, { type: 'error' }>;
  onUnlockAndRetry: (retryMessage: string) => void;
}) {
  return (
    <div className="rounded-md text-[11px] text-destructive/80 px-3 py-1.5 bg-destructive/[0.04] border border-destructive/10">
      <div>{msg.content}</div>
      {msg.retryMessage && (
        <button
          onClick={() => { void onUnlockAndRetry(msg.retryMessage!); }}
          className="mt-1.5 text-[11px] px-2 py-0.5 rounded-md border border-destructive/30 text-destructive/90 bg-transparent hover:bg-destructive/10 cursor-pointer transition-colors"
        >
          {msg.content.includes('解除占用') ? '解除占用并重试' : '重试'}
        </button>
      )}
    </div>
  );
}

/** 流式消息：正文 + 三点脉冲（统一的活动指示）。 */
function StreamingRow({ msg, agentStreaming }: {
  msg: Extract<AgentStepMessage, { type: 'streaming' }>;
  agentStreaming: boolean;
}) {
  const hasContent = !!msg.content;
  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] px-3 py-2 border-l-2 border-foreground/10 text-[13px] leading-relaxed">
        {hasContent && <MarkdownContent>{msg.content}</MarkdownContent>}
        {agentStreaming && (
          <div className={cn('flex', hasContent && 'mt-1.5')}>
            <span className="inline-flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-foreground/30 animate-pulse" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-foreground/30 animate-pulse" style={{ animationDelay: '200ms' }} />
              <span className="w-1 h-1 rounded-full bg-foreground/30 animate-pulse" style={{ animationDelay: '400ms' }} />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** 消息 hover 操作栏（右下角 icon 化）：复制 / 编辑。 */
function HoverActions({ canCopy, canEdit, onCopy, onEdit }: {
  canCopy: boolean;
  canEdit: boolean;
  onCopy: () => void;
  onEdit: () => void;
}) {
  if (!canCopy && !canEdit) return null;
  return (
    <div className="absolute -bottom-3 right-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {canCopy && (
        <button
          onClick={onCopy}
          className="h-5 w-5 flex items-center justify-center rounded bg-background border border-border/60 text-muted-foreground hover:text-foreground cursor-pointer"
          title="复制内容"
        >
          <Copy size={11} strokeWidth={1.5} />
        </button>
      )}
      {canEdit && (
        <button
          onClick={onEdit}
          className="h-5 w-5 flex items-center justify-center rounded bg-background border border-border/60 text-muted-foreground hover:text-foreground cursor-pointer"
          title="编辑并重新发送"
        >
          <Pencil size={11} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

/** user 消息行内编辑：消息原位展开为编辑框（替代回填输入框），确认后发送新回合。 */
function InlineEditBox({ initial, onConfirm, onCancel }: {
  initial: string;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const confirm = () => {
    if (draft.trim()) onConfirm(draft.trim());
    else onCancel();
  };
  return (
    <div className="w-full">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirm(); }
          if (e.key === 'Escape') onCancel();
        }}
        rows={Math.min(Math.max(draft.split('\n').length, 2), 6)}
        className="w-full resize-y rounded-md border border-foreground/15 bg-background px-2.5 py-1.5 text-[12px] outline-none focus:border-foreground/30"
      />
      <div className="flex justify-end gap-1.5 mt-1.5">
        <button
          onClick={onCancel}
          className="h-6 px-2 flex items-center gap-1 rounded border border-border/60 text-[10px] text-muted-foreground hover:text-foreground bg-transparent cursor-pointer"
        >
          <X size={10} strokeWidth={1.5} /> 取消
        </button>
        <button
          onClick={confirm}
          className="h-6 px-2 flex items-center gap-1 rounded bg-foreground/10 border border-foreground/20 text-[10px] text-foreground hover:bg-foreground/15 cursor-pointer"
        >
          <Check size={10} strokeWidth={1.5} /> 发送
        </button>
      </div>
    </div>
  );
}

/** 普通文本消息（user / assistant / system / suggestions）：hover 复制/编辑。 */
function TextRow({ msg, onCopy, onInlineEditSend }: {
  msg: AgentStepMessage;
  onCopy: (text: string) => void;
  onInlineEditSend: (text: string, roundId?: string) => void;
}) {
  const isUser = msg.role === 'user';
  const [editing, setEditing] = useState(false);
  if (editing && isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] w-full">
          <InlineEditBox
            initial={msg.content}
            onConfirm={(text) => {
              setEditing(false);
              onInlineEditSend(text, msg.roundId);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      </div>
    );
  }
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={cn(
        'max-w-[88%] text-[13px] leading-relaxed group relative',
        isUser
          ? 'rounded-2xl bg-[color-mix(in_srgb,var(--foreground)_12%,transparent)] text-foreground/85 backdrop-blur-sm px-3.5 py-1.5'
          : 'px-3 py-2 border-l-2 border-foreground/10 agent-markdown',
      )}>
        {isUser ? msg.content : <MarkdownContent>{msg.content}</MarkdownContent>}
        <HoverActions
          canCopy={!isUser && Boolean(msg.content)}
          canEdit={isUser && Boolean(msg.content)}
          onCopy={() => { void onCopy(msg.content); }}
          onEdit={() => setEditing(true)}
        />
      </div>
    </div>
  );
}

/** 个人知识库引用卡：展示随回合注入的文档名与命中片段，可展开查看。 */
function RagRefRow({ msg }: { msg: Extract<AgentStepMessage, { type: 'rag-ref' }> }) {
  const [expanded, setExpanded] = useState(false);
  if (!msg.refs?.length) return null;
  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] rounded-md border border-foreground/10 bg-foreground/[0.03] overflow-hidden">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground/80 bg-transparent border-none cursor-pointer hover:bg-muted/40 text-left"
        >
          <FileText size={11} strokeWidth={1.5} className="shrink-0 text-foreground/40" />
          <span>已注入 {msg.refs.length} 篇个人知识库文档</span>
          <ChevronDown size={11} strokeWidth={1.5} className={cn('ml-auto text-foreground/30 transition-transform', expanded && 'rotate-180')} />
        </button>
        {expanded && (
          <div className="px-3 pb-2 space-y-1.5">
            {msg.refs.map((r, i) => (
              <div key={`${r.docName}-${i}`} className="text-[11px] leading-relaxed">
                <span className="font-medium text-foreground/70">{r.docName}</span>
                <span className="block text-foreground/50 line-clamp-3 whitespace-pre-wrap break-words">{r.snippet}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 内置事件渲染器注册（模块加载时执行一次）：协议 v2 建卡型事件 →
 * 渲染组件。更新型事件（*_token/*_end）不独立建卡不注册；未匹配
 * 类型走折叠兜底（FoldRow）。
 */
function registerBuiltinMessageRenderers(): void {
  registerMessageRenderer('review-card', (props) => {
    const msg = props.msg;
    if (msg.type !== 'review-card' || !msg.token) return null;
    const reviewData = safeParseJSON(msg.token);
    return reviewData ? (
      <ReviewCard
        data={reviewData as Record<string, unknown>}
        onAction={props.onReviewAction}
        // 历史回放卡只读（live:false 不渲染操作按钮）
        disabled={msg.live === false}
      />
    ) : null;
  });
  registerMessageRenderer('tool', (props) => {
    const msg = props.msg as Extract<AgentStepMessage, { type: 'tool' }>;
    return <ToolRow msg={msg} />;
  });
  registerMessageRenderer('node', (props) => {
    const msg = props.msg as Extract<AgentStepMessage, { type: 'node' }>;
    return <NodeRow msg={msg} />;
  });
  registerMessageRenderer('streaming', (props) => {
    const msg = props.msg as Extract<AgentStepMessage, { type: 'streaming' }>;
    return <StreamingRow msg={msg} agentStreaming={props.agentStreaming} />;
  });
  registerMessageRenderer('error', (props) => {
    const msg = props.msg as Extract<AgentStepMessage, { type: 'error' }>;
    return <ErrorRow msg={msg} onUnlockAndRetry={props.onUnlockAndRetry} />;
  });
  registerMessageRenderer('rag-ref', (props) => {
    const msg = props.msg as Extract<AgentStepMessage, { type: 'rag-ref' }>;
    return <RagRefRow msg={msg} />;
  });
  registerMessageRenderer('thinking', (props) => {
    const msg = props.msg as Extract<AgentStepMessage, { type: 'thinking' }>;
    return <ThinkingRow msg={msg} />;
  });
  registerMessageRenderer('plan', (props) => {
    const msg = props.msg as Extract<AgentStepMessage, { type: 'plan' }>;
    return <PlanRow msg={msg} />;
  });
  // 旧 node-output 消息已迁移到节点卡片内部，不渲染（避免与节点卡片重复）。
  registerMessageRenderer('node-output', () => null);
}

registerBuiltinMessageRenderers();

export function MessageItem(props: MessageItemProps) {
  const { msg } = props;
  // 稳定 key：消息插入时生成的 id 优先，历史映射消息用后端消息 id，均稳定；
  // key 放在外层容器，保证 React 按消息身份复用/卸载而非按 index。
  const stableKey = msg.id || `i-${props.index}`;
  const renderer = messageRenderer(msg.type || '');
  let content: React.ReactNode;
  if (renderer) {
    content = renderer(props);
  } else if ('token' in msg && msg.token) {
    // 未注册事件类型：折叠兜底展示原始 JSON（回放不崩，可审计）
    content = <FoldRow data={msg.token} />;
  } else {
    content = (
      <TextRow msg={msg} onCopy={props.onCopy} onInlineEditSend={props.onInlineEditSend} />
    );
  }
  return <div key={stableKey}>{content}</div>;
}
