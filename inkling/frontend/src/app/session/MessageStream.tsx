/**
 * 消息流（B 区）：entries 按时间序追加，append-only。
 *
 * 呈现规范（参考桌面 agent 产品）：
 * - 用户气泡右侧实底，无时间戳；hover 露出复制钮（气泡下方右对齐小图标）；
 * - 助手正文左侧纸面直排，流式光标走文字色（不占朱砂语义）；
 * - 错误条目单行形态：红点 + 失败摘要 + 右侧错误码；
 * - 推演分支对比内嵌为卡片（数据 = state.simulations 快照），选中态可见；
 * - 工具/事件卡片只用真实 token 取色，不引用不存在的变量。
 */

import { useRef, useState } from 'react';
import { Check, CheckCircle2, Copy, AlertTriangle, Clock, Zap } from 'lucide-react';
import { PulseLine } from './PulseLine';
import { PhaseCapsule } from './PhaseCapsule';
import { ToolDrawer } from './ToolDrawer';
import { SpawnPanel, type SpawnInstance } from './SpawnPanel';
import type { RoundStep, SimulationBranch } from '@/shared/session/types';

export interface MessageEntry {
  id: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'event' | 'spawn' | 'system' | 'error';
  content?: string;
  at: number;
  meta?: Record<string, unknown>;
}

interface MessageStreamProps {
  entries: MessageEntry[];
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

export function MessageStream({ entries, streaming, roundSteps, pulseText, pulseColor, simulations, spawnInstances, onSpawnSelect, selectedSpawnIndex, onSpawnSendInstruction, spawnStreaming, onBranchFromMessage: _onBranchFromMessage }: MessageStreamProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTitle, setDrawerTitle] = useState('');
  const [drawerContent, setDrawerContent] = useState<string>('');
  const [spawnPanelOpen, setSpawnPanelOpen] = useState(false);

  return (
    <div ref={listRef} className="flex-1 overflow-y-auto px-6 py-6">
      {entries.length === 0 && (
        <EmptyHero />
      )}
      <div className="mx-auto max-w-4xl space-y-5">
        {roundSteps && roundSteps.length > 0 && (
          <PhaseCapsule steps={roundSteps.map((s) => ({ id: s.stepId, label: s.label || s.type, status: s.status }))} />
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="ink-feed">
            {entry.kind === 'user' && <UserBubble content={entry.content ?? ''} />}
            {entry.kind === 'assistant' && <AssistantText content={entry.content ?? ''} streaming={streaming} />}
            {entry.kind === 'thinking' && <ThinkingCard entry={entry} />}
            {entry.kind === 'tool' && <ToolCard entry={entry} onExpand={(title, content) => { setDrawerTitle(title); setDrawerContent(content); setDrawerOpen(true); }} />}
            {entry.kind === 'event' && <EventCard entry={entry} />}
            {entry.kind === 'spawn' && <SpawnCard entry={entry} onOpenPanel={() => setSpawnPanelOpen(true)} />}
            {entry.kind === 'error' && <ErrorLine entry={entry} />}
            {entry.kind === 'system' && <SystemLine entry={entry} />}
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

/** 空态 hero（参考桌面 agent 空态：居中品牌图标 + 首任务引导）。 */
function EmptyHero() {
  return (
    <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <div className="flex items-center gap-2">
        <img src="/icon.ico" alt="InKling" className="h-7 w-7" />
        <span className="text-[17px] font-semibold tracking-tight">InKling</span>
      </div>
      <div className="space-y-1">
        <h1 className="text-[22px] font-semibold tracking-tight">开始你的第一个任务</h1>
        <p className="text-[13px] ink-text-faint">描述你想要构建的内容，智能体将自主规划、执行并演化</p>
      </div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
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

function ThinkingCard({ entry }: { entry: MessageEntry }) {
  const [open, setOpen] = useState(false);
  const duration = entry.meta?.duration as number | undefined;
  return (
    <div className="ink-status-card rounded-xl p-3">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-[12px] ink-text-muted">
        <Zap size={12} strokeWidth={1.6} />
        <span>思考</span>
        {duration != null && <span>· {duration.toFixed(1)}s</span>}
        <span className="ml-auto">{open ? '收起' : '展开'}</span>
      </button>
      {open && entry.content && (
        <div className="mt-2 ink-status-bubble rounded-lg p-3 text-[12px] leading-relaxed">{entry.content}</div>
      )}
    </div>
  );
}

function ToolCard({ entry, onExpand }: { entry: MessageEntry; onExpand: (title: string, content: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const status = (entry.meta?.status as string) || 'running';
  const isError = status === 'error';
  const errorReason = entry.meta?.errorReason as string | undefined;
  const toolName = (entry.meta?.toolName as string) || '工具';
  const output = entry.content ?? '';

  return (
    <div className="ink-status-card rounded-xl p-3">
      <div className="flex items-center gap-2 text-[12px]">
        <span className={`h-2 w-2 rounded-full ${isError ? 'bg-[var(--ink-accent-approval)]' : status === 'ok' ? 'bg-[var(--ink-text-muted)]' : 'bg-[var(--ink-text-faint)] animate-pulse'}`} />
        <span className="font-medium">{toolName}</span>
        <span className="ink-text-faint">· {entry.meta?.summary as string || ''}</span>
        {entry.meta?.duration != null && <span className="ink-text-faint">· {(entry.meta.duration as number).toFixed(2)}s</span>}
        <button type="button" onClick={() => setExpanded(!expanded)} className="ml-auto text-[11px] ink-text-muted hover:text-[var(--ink-text-base)]">
          {expanded ? '收起' : '查看输出'}
        </button>
      </div>
      {isError && (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--ink-accent-approval)]">
          <AlertTriangle size={12} strokeWidth={1.6} />
          <span>失败 · {errorReason || '执行异常'}</span>
        </div>
      )}
      {expanded && (
        <div className="mt-2">
          <pre className="max-h-60 overflow-auto rounded-lg bg-[var(--ink-bg-surface)] p-3 text-[12px]">{output}</pre>
          {output.length > 120 && (
            <button type="button" onClick={() => onExpand(`${toolName} 完整输出`, output)} className="mt-2 text-[11px] ink-text-muted hover:text-[var(--ink-text-base)]">
              查看完整
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EventCard({ entry }: { entry: MessageEntry }) {
  const kind = entry.meta?.eventKind as string | undefined;
  if (kind === 'knowledge_hit') {
    const confidence = entry.meta?.confidence as number | undefined;
    return (
      <div className="ink-status-card flex items-center gap-2 rounded-xl px-3 py-2 text-[12px]">
        <span className={`h-2 w-2 rounded-full ${confidence != null && confidence >= 0.5 ? 'bg-[var(--ink-text-muted)]' : 'bg-[var(--ink-text-faint)]'}`} />
        <span>知识检索 · 已放行 · {entry.meta?.count as number || 0} 条相关记忆</span>
        {confidence != null && <span className="ink-text-faint">可信度 {confidence.toFixed(2)}</span>}
      </div>
    );
  }
  if (kind === 'review') {
    const verdict = entry.meta?.verdict as string | undefined;
    return (
      <div className="ink-status-card flex items-center gap-2 rounded-xl px-3 py-2 text-[12px]">
        <CheckCircle2 size={12} strokeWidth={1.6} className={verdict === 'fail' ? 'text-[var(--ink-accent-approval)]' : 'ink-text-muted'} />
        <span>评审 · {verdict === 'pass' ? '通过' : verdict === 'fail' ? '未通过' : '观察中'}</span>
      </div>
    );
  }
  return (
    <div className="ink-status-card rounded-xl px-3 py-2 text-[12px] ink-text-muted">
      {entry.content || '事件'}
    </div>
  );
}

function SpawnCard({ entry, onOpenPanel }: { entry: MessageEntry; onOpenPanel: () => void }) {
  const count = (entry.meta?.count as number) || 0;
  return (
    <div className="ink-status-card rounded-xl p-3">
      <div className="flex items-center gap-2 text-[12px]">
        <Zap size={12} strokeWidth={1.6} className="ink-text-muted" />
        <span className="font-medium">子代理 · {count} 个实例</span>
        <span className="ink-text-faint">并行执行中</span>
        <button type="button" onClick={onOpenPanel} className="ml-auto text-[11px] ink-text-muted hover:text-[var(--ink-text-base)]">
          打开面板
        </button>
      </div>
      <div className="mt-2 space-y-1 pl-4">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 text-[12px] ink-text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--ink-text-faint)] animate-pulse" />
            <span>实例 {i + 1}</span>
            <span className="ink-text-faint">· 执行中</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 推演分支对比卡（内嵌消息流；只读呈现，换选交互归开发者模式推演视图）。 */
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

/** 错误单行（参考形态：红点 + 摘要 + 右侧错误码）。 */
function ErrorLine({ entry }: { entry: MessageEntry }) {
  const code = entry.meta?.code as string | undefined;
  return (
    <div className="flex items-start gap-2 px-1 text-[12px]" data-ui="error_line">
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--ink-accent-approval)]" />
      <p className="min-w-0 flex-1 leading-relaxed text-[var(--ink-accent-approval)]">
        <span className="font-medium">本轮运行失败</span>
        {entry.content ? <span className="ink-text-muted">　{entry.content}</span> : null}
      </p>
      {code && <span className="shrink-0 pt-0.5 font-mono text-[11px] ink-text-faint">{code}</span>}
    </div>
  );
}

function SystemLine({ entry }: { entry: MessageEntry }) {
  return (
    <div className="flex items-center gap-2 px-1 text-[12px] ink-text-faint">
      <Clock size={12} strokeWidth={1.6} />
      <span>{entry.content || '系统消息'}</span>
    </div>
  );
}
