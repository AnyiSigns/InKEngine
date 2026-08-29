/**
 * 消息流（B 区）：entries 按时间序追加，append-only。
 *
 * 呈现规范（参考桌面 agent 产品）：
 * - 用户气泡右侧实底，无时间戳；hover 露出复制钮（气泡下方右对齐小图标）；
 * - 助手正文左侧纸面直排，流式光标走文字色（不占朱砂语义）；
 * - 错误条目单行形态：红点 + 失败摘要 + 右侧错误码；
 * - 推演分支对比内嵌为卡片（数据 = state.simulations 快照），选中态可见；
 * - 工具/事件卡片只用真实 token 取色，不引用不存在的变量；
 * - agent 状态内联卡：知识命中（记忆召回）/ 设备感知控制 / 审查（vetting）
 *   以消息流形态展示「智能体为什么这么做 / 做了什么」，不塞进设置。
 */

import { useRef, useState, type ComponentType } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Database,
  MousePointerClick,
  Monitor,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { PulseLine } from './PulseLine';
import { PhaseCapsule } from './PhaseCapsule';
import { ToolDrawer } from './ToolDrawer';
import { SpawnPanel, type SpawnInstance } from './SpawnPanel';
import type { InkMessage, RoundStep, SimulationBranch } from '@/shared/session/types';
import { assetOf, MediaRejected } from '@/components/messages/media_entries';
import { resolveMediaRenderer } from '@/renderer/mediaRegistry';
import { ChartEntry } from '@/components/messages/chart_entry';
import { useDevMode } from '@/shared/ui/devMode';

interface MessageStreamProps {
  entries: InkMessage[];
  streaming?: boolean;
  roundSteps?: RoundStep[];
  pulseText?: string;
  pulseColor?: 'default' | 'approval' | 'warn';
  /** 推演分支快照（内嵌对比卡；空数组不渲染）。 */
  simulations?: SimulationBranch[];
  spawnInstances?: SpawnInstance[];
  onSpawnSelect?: (index: number) => void;
  selectedSpawnIndex?: number | null;
  onSpawnSendInstruction?: (text: string) => void;
  spawnStreaming?: boolean;
  onBranchFromMessage: (messageId: string, branchLabel: string) => void;
}

export function MessageStream({
  entries,
  streaming,
  roundSteps,
  pulseText,
  pulseColor,
  simulations,
  spawnInstances,
  onSpawnSelect,
  selectedSpawnIndex,
  onSpawnSendInstruction,
  spawnStreaming,
  onBranchFromMessage: _onBranchFromMessage,
}: MessageStreamProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTitle, setDrawerTitle] = useState('');
  const [drawerContent, setDrawerContent] = useState<string>('');
  const [spawnPanelOpen, setSpawnPanelOpen] = useState(false);

  return (
    <div ref={listRef} className="flex-1 overflow-y-auto px-6 py-6">
      {entries.length === 0 && <EmptyHero />}
      <div className="mx-auto max-w-4xl space-y-5">
        {roundSteps && roundSteps.length > 0 && (
          <PhaseCapsule
            steps={roundSteps.map((s) => ({ id: s.stepId, label: s.label || s.type, status: s.status }))}
          />
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="ink-feed">
            <MessageItem
              entry={entry}
              streaming={streaming}
              onExpand={(title, content) => {
                setDrawerTitle(title);
                setDrawerContent(content);
                setDrawerOpen(true);
              }}
              onOpenPanel={() => setSpawnPanelOpen(true)}
            />
          </div>
        ))}
        {simulations && simulations.length > 0 && <SimulationCard branches={simulations} />}
      </div>
      {pulseText && <PulseLine text={pulseText} color={pulseColor} />}
      <ToolDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title={drawerTitle}>
        <pre className="whitespace-pre-wrap text-xs">{drawerContent}</pre>
      </ToolDrawer>
      {spawnInstances && spawnInstances.length > 0 && (
        <SpawnPanel
          open={spawnPanelOpen}
          onClose={() => setSpawnPanelOpen(false)}
          instances={spawnInstances}
          selectedIndex={selectedSpawnIndex ?? null}
          onSelectIndex={(idx) => onSpawnSelect?.(idx)}
          onSendInstruction={(text) => onSpawnSendInstruction?.(text)}
          streaming={spawnStreaming ?? false}
        />
      )}
    </div>
  );
}

/** 单条消息渲染分发（InkMessage 全 kind）。 */
function MessageItem({
  entry,
  streaming,
  onExpand,
  onOpenPanel,
}: {
  entry: InkMessage;
  streaming?: boolean;
  onExpand: (title: string, content: string) => void;
  onOpenPanel: () => void;
}) {
  switch (entry.kind) {
    case 'text':
      if (entry.role === 'user') return <UserBubble content={entry.content} />;
      if (entry.role === 'system') return <SystemLine content={entry.content} />;
      return <AssistantText content={entry.content} streaming={streaming} />;
    case 'streaming':
      return <AssistantText content={entry.content} streaming />;
    case 'thinking':
      return <ThinkingCard entry={entry} />;
    case 'plan': {
      const running = entry.status === 'running';
      return (
        <div className="ink-status-card rounded-xl p-3" data-ui="plan_card">
          <div className="flex items-center gap-2 text-[12px]">
            <span className={`h-2 w-2 rounded-full ${running ? 'bg-[var(--ink-text-muted)] animate-pulse' : 'bg-[var(--ink-text-faint)]'}`} />
            <span className="font-medium">计划</span>
            {entry.workflow && <span className="ink-chip text-[10px]">{entry.workflow}</span>}
            <span className="ink-text-faint">{running ? '规划中' : '已完成'}</span>
          </div>
          {entry.content && (
            <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed ink-text-muted">{entry.content}</p>
          )}
        </div>
      );
    }
    case 'tool':
      return <ToolCard entry={entry} onExpand={onExpand} />;
    case 'spawn':
      return <SpawnCard entry={entry} onOpenPanel={onOpenPanel} />;
    case 'device':
      return <DeviceCard entry={entry} />;
    case 'knowledge_hit':
      return <KnowledgeHitCard entry={entry} />;
    case 'vetting':
      return <VettingCard entry={entry} />;
    case 'review_card':
      return <ReviewInline entry={entry} />;
    case 'suggestions':
      return <SuggestionsCard entry={entry} />;
    case 'error':
      return <ErrorLine entry={entry} />;
    case 'image':
    case 'video':
    case 'document': {
      const renderer = resolveMediaRenderer(entry.kind);
      if (!renderer) return <MediaRejected kind={entry.kind} reason="未登记媒体渲染器" />;
      const MediaComp = renderer as ComponentType<{ asset: import('@/renderer/mediaRegistry').MediaAssetView }>;
      const asset = assetOf(entry as Parameters<typeof assetOf>[0]);
      return <div className="max-w-[80%]"><MediaComp asset={asset} /></div>;
    }
    case 'chart':
      return <ChartEntry message={entry} />;
    case 'unknown':
      return <UnknownLine entry={entry} />;
    default:
      return null;
  }
}

/** 知识命中内联卡（记忆召回 → 消息流）。 */
function KnowledgeHitCard({ entry }: { entry: Extract<InkMessage, { kind: 'knowledge_hit' }> }) {
  const hits = entry.hits;
  return (
    <div className="ink-status-card flex items-start gap-2 rounded-xl px-3 py-2 text-[12px]" data-ui="knowledge_hit_card">
      <Database size={12} strokeWidth={1.6} className="mt-0.5 shrink-0 ink-text-faint" />
      <div className="min-w-0 flex-1">
        <span className="ink-text-muted">知识检索 · 已放行 · {hits.length} 条相关记忆</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {hits.slice(0, 4).map((h) => (
            <span key={h.id} title={h.snippet} className="ink-chip max-w-56 truncate">
              {h.title}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 设备感知/控制内联卡（信任审计核心）。 */
function DeviceCard({ entry }: { entry: Extract<InkMessage, { kind: 'device' }> }) {
  const isSense = entry.action.startsWith('sensed') || entry.action.includes('感知');
  return (
    <div className="ink-status-card flex items-start gap-2 rounded-xl px-3 py-2 text-[12px]" data-ui="device_card">
      {isSense ? (
        <Monitor size={12} strokeWidth={1.6} className="mt-0.5 shrink-0 ink-text-faint" />
      ) : (
        <MousePointerClick size={12} strokeWidth={1.6} className="mt-0.5 shrink-0 ink-text-faint" />
      )}
      <div className="min-w-0 flex-1">
        <span className="font-medium">{isSense ? '设备感知' : '设备操作'}</span>
        <span className="ml-1.5 ink-text-muted">{entry.action}</span>
        {entry.detail && <p className="mt-0.5 text-[11px] leading-relaxed ink-text-faint">{entry.detail}</p>}
      </div>
    </div>
  );
}

/** 审查（vetting）内联卡：pass/fail/review 三态。 */
function VettingCard({ entry }: { entry: Extract<InkMessage, { kind: 'vetting' }> }) {
  const { tool, verdict, reason } = entry;
  const isFail = verdict === 'fail';
  const isReview = verdict === 'review';
  return (
    <div className="ink-status-card flex items-start gap-2 rounded-xl px-3 py-2 text-[12px]" data-ui="vetting_card" data-verdict={verdict}>
      {isFail ? (
        <AlertTriangle size={12} strokeWidth={1.6} className="mt-0.5 shrink-0 ink-accent" />
      ) : (
        <ShieldCheck size={12} strokeWidth={1.6} className="mt-0.5 shrink-0 ink-text-faint" />
      )}
      <div className="min-w-0 flex-1">
        <span className="font-medium">{tool || '工具'}</span>
        <span className="ml-1.5 ink-text-muted">
          {isFail ? '审查未通过' : isReview ? '审查需人工复核' : '已通过审查'}
        </span>
        {reason && <p className="mt-0.5 text-[11px] leading-relaxed ink-text-faint">{reason}</p>}
      </div>
      {isReview && <span className="shrink-0 ink-chip text-[10px] ink-text-muted">待复核</span>}
    </div>
  );
}

/** 审批卡消息（历史留痕：裁决徽标）。 */
function ReviewInline({ entry }: { entry: Extract<InkMessage, { kind: 'review_card' }> }) {
  const payload = entry.payload;
  const title = String(payload.title ?? payload.key ?? payload.action ?? '审批请求');
  const verdict = String(payload.verdict ?? '');
  const badge = verdict === 'accept' ? '已批准' : verdict === 'reject' ? '已驳回' : '待决议';
  return (
    <div className="ink-status-card flex items-center gap-2 rounded-xl px-3 py-2 text-[12px]" data-ui="review_inline">
      <span className={`h-2 w-2 rounded-full ${verdict ? 'bg-[var(--ink-text-muted)]' : 'bg-[var(--ink-accent-approval)] animate-pulse'}`} />
      <span className="font-medium">{title}</span>
      <span className="ml-auto ink-chip text-[10px]">{badge}</span>
    </div>
  );
}

/** 建议条（suggestions 事件）。 */
function SuggestionsCard({ entry }: { entry: Extract<InkMessage, { kind: 'suggestions' }> }) {
  return (
    <div className="flex flex-wrap gap-1.5 px-1">
      {entry.items.map((item, i) => (
        <span key={i} className="ink-chip px-2 py-1 text-[11px]">
          {item}
        </span>
      ))}
    </div>
  );
}

/** 未注册事件兜底（仅开发者模式渲染）。 */
function UnknownLine({ entry }: { entry: Extract<InkMessage, { kind: 'unknown' }> }) {
  const [devMode] = useDevMode();
  if (!devMode) return null;
  return (
    <div className="ink-status-card rounded-xl px-3 py-2 text-[11px] ink-text-faint" data-ui="unknown_message">
      <pre className="whitespace-pre-wrap break-all">{entry.token}</pre>
    </div>
  );
}

/** 空态 hero（参考桌面 agent 空态：居中品牌标记 + 首任务引导）。 */
function EmptyHero() {
  return (
    <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <div className="flex items-center gap-2">
        <span className="brand-mark h-6 w-6" aria-hidden="true" />
        <span className="text-[17px] font-semibold tracking-tight">InKling</span>
      </div>
      <div className="space-y-1">
        <h1 className="text-[22px] font-semibold tracking-tight">开始你的第一个任务</h1>
        <p className="text-[13px] ink-text-faint">描述你想要构建的内容，智能体将自主规划、执行并演化</p>
      </div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  return (
    <div className="group flex flex-col items-end">
      <div className="ink-bubble-user max-w-[80%] px-4 py-2.5 text-[15px] leading-relaxed">
        <p className="whitespace-pre-wrap">{content}</p>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label="复制"
        className="mt-1 flex h-6 w-6 items-center justify-center rounded-md ink-text-faint opacity-0 transition-opacity hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)] group-hover:opacity-100"
      >
        {copied ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.6} />}
      </button>
    </div>
  );
}

function AssistantText({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <div className="ink-markdown text-[15px] leading-relaxed">
      {content}
      {streaming && <span className="ink-caret-muted" />}
    </div>
  );
}

function ThinkingCard({ entry }: { entry: Extract<InkMessage, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(false);
  const running = entry.status === 'running';
  return (
    <div className="ink-status-card rounded-xl p-3">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-[12px] ink-text-muted">
        <Zap size={12} strokeWidth={1.6} />
        <span>思考</span>
        <span className="ink-text-faint">· {running ? '推理中' : '已完成'}</span>
        <span className="ml-auto">{open ? '收起' : '展开'}</span>
      </button>
      {open && entry.content && (
        <div className="mt-2 ink-status-bubble rounded-lg p-3 text-[12px] leading-relaxed">
          {entry.content}
          {running && <span className="ink-caret-muted" />}
        </div>
      )}
    </div>
  );
}

function ToolCard({
  entry,
  onExpand,
}: {
  entry: Extract<InkMessage, { kind: 'tool' }>;
  onExpand: (title: string, content: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isError = entry.toolStatus === 'error';
  const toolName = entry.title || entry.tool || '工具';
  const output = entry.args ?? '';

  return (
    <div className="ink-status-card rounded-xl p-3">
      <div className="flex items-center gap-2 text-[12px]">
        <span className={`h-2 w-2 rounded-full ${isError ? 'bg-[var(--ink-accent-approval)]' : entry.toolStatus === 'done' ? 'bg-[var(--ink-text-muted)]' : 'bg-[var(--ink-text-faint)] animate-pulse'}`} />
        <span className="font-medium">{toolName}</span>
        <span className="ink-text-faint">· {entry.summary || ''}</span>
        {entry.toolStatus === 'running' && <span className="ink-text-faint">· 进行中</span>}
        <button type="button" onClick={() => setExpanded(!expanded)} className="ml-auto text-[11px] ink-text-muted hover:text-[var(--ink-text-base)]">
          {expanded ? '收起' : '查看参数'}
        </button>
      </div>
      {isError && (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--ink-accent-approval)]">
          <AlertTriangle size={12} strokeWidth={1.6} />
          <span>失败 · {entry.summary || '执行异常'}</span>
        </div>
      )}
      {expanded && (
        <div className="mt-2">
          <pre className="max-h-60 overflow-auto rounded-lg bg-[var(--ink-bg-surface)] p-3 text-[12px]">{output || '（无参数）'}</pre>
          {output.length > 120 && (
            <button type="button" onClick={() => onExpand(`${toolName} 完整参数`, output)} className="mt-2 text-[11px] ink-text-muted hover:text-[var(--ink-text-base)]">
              查看完整
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SpawnCard({
  entry,
  onOpenPanel,
}: {
  entry: Extract<InkMessage, { kind: 'spawn' }>;
  onOpenPanel: () => void;
}) {
  const running = entry.status === 'running';
  return (
    <div className="ink-status-card rounded-xl p-3">
      <div className="flex items-center gap-2 text-[12px]">
        <Zap size={12} strokeWidth={1.6} className="ink-text-muted" />
        <span className="font-medium">{entry.label || '子代理'}</span>
        <span className="ink-text-faint">{running ? '执行中' : '已完成'}</span>
        {entry.reason && <span className="min-w-0 flex-1 truncate text-[11px] ink-text-faint">{entry.reason}</span>}
        <button type="button" onClick={onOpenPanel} className="ml-auto text-[11px] ink-text-muted hover:text-[var(--ink-text-base)]">
          打开面板
        </button>
      </div>
    </div>
  );
}

/** 推演分支对比卡（内嵌消息流；只读呈现，换选为引擎自主机制，不暴露交互）。 */
function SimulationCard({ branches }: { branches: SimulationBranch[] }) {
  return (
    <div className="ink-status-card rounded-xl p-3" data-ui="simulation_inline_card">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="font-medium">推演分支</span>
        <span className="ink-text-faint">{branches.length} 条候选路径</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {branches.map((b) => (
          <div
            key={b.branchId}
            data-selected={b.selected || undefined}
            className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[12px] ${
              b.selected ? 'ink-border-strong bg-[var(--ink-bg-elevated)]' : 'ink-border'
            }`}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{b.label}</span>
            {b.rationale && <span className="hidden max-w-[40%] truncate ink-text-faint sm:inline">{b.rationale}</span>}
            <span className="shrink-0 tabular-nums ink-text-muted">{b.score.toFixed(2)}</span>
            {b.selected && <span className="ink-chip shrink-0 text-[10px]">已选</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 错误单行（参考形态：红点 + 摘要）。 */
function ErrorLine({ entry }: { entry: Extract<InkMessage, { kind: 'error' }> }) {
  return (
    <div className="flex items-start gap-2 px-1 text-[12px]" data-ui="error_line">
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--ink-accent-approval)]" />
      <p className="min-w-0 flex-1 leading-relaxed text-[var(--ink-accent-approval)]">
        <span className="font-medium">本轮运行失败</span>
        {entry.content ? <span className="ink-text-muted">　{entry.content}</span> : null}
      </p>
    </div>
  );
}

function SystemLine({ content }: { content: string }) {
  return (
    <div className="flex items-center gap-2 px-1 text-[12px] ink-text-faint">
      <Clock size={12} strokeWidth={1.6} />
      <span>{content || '系统消息'}</span>
    </div>
  );
}
