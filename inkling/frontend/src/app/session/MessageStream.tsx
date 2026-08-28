/**
 * 消息流（B 区）：entries 按时间序追加，append-only。
 */

import { useRef, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Clock, Zap } from 'lucide-react';
import { PulseLine } from './PulseLine';
import { PhaseCapsule } from './PhaseCapsule';
import { ToolDrawer } from './ToolDrawer';
import { SpawnPanel, type SpawnInstance } from './SpawnPanel';
import type { RoundStep } from '@/shared/session/types';

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
  spawnInstances?: SpawnInstance[];
  onSpawnSelect?: (index: number) => void;
  selectedSpawnIndex?: number | null;
  onSpawnSendInstruction?: (text: string) => void;
  spawnStreaming?: boolean;
  onBranchFromMessage: (messageId: string, branchLabel: string) => void;
}

export function MessageStream({ entries, streaming, roundSteps, pulseText, pulseColor, spawnInstances, onSpawnSelect, selectedSpawnIndex, onSpawnSendInstruction, spawnStreaming, onBranchFromMessage: _onBranchFromMessage }: MessageStreamProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTitle, setDrawerTitle] = useState('');
  const [drawerContent, setDrawerContent] = useState<string>('');
  const [spawnPanelOpen, setSpawnPanelOpen] = useState(false);

  return (
    <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4">
      {entries.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center text-xs ink-text-faint">
          <p>开始你的第一个任务</p>
        </div>
      )}
      <div className="mx-auto max-w-3xl space-y-4">
        {roundSteps && roundSteps.length > 0 && (
          <PhaseCapsule steps={roundSteps.map((s) => ({ id: s.stepId, label: s.label || s.type, status: s.status }))} />
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="ink-feed">
            {entry.kind === 'user' && <UserBubble content={entry.content ?? ''} at={entry.at} />}
            {entry.kind === 'assistant' && <AssistantText content={entry.content ?? ''} streaming={streaming} />}
            {entry.kind === 'thinking' && <ThinkingCard entry={entry} />}
            {entry.kind === 'tool' && <ToolCard entry={entry} onExpand={(title, content) => { setDrawerTitle(title); setDrawerContent(content); setDrawerOpen(true); }} />}
            {entry.kind === 'event' && <EventCard entry={entry} />}
            {entry.kind === 'spawn' && <SpawnCard entry={entry} onOpenPanel={() => setSpawnPanelOpen(true)} />}
            {entry.kind === 'error' && <ErrorCard entry={entry} />}
            {entry.kind === 'system' && <SystemLine entry={entry} />}
          </div>
        ))}
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

function UserBubble({ content, at }: { content: string; at: number }) {
  return (
    <div className="flex justify-end">
      <div className="ink-bubble-user max-w-[80%] rounded-2xl px-4 py-2 text-sm" style={{ borderBottomRightRadius: 6 }}>
        <p className="whitespace-pre-wrap">{content}</p>
        <span className="mt-1 block text-right text-[10px] opacity-60">{new Date(at).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

function AssistantText({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <div className="ink-markdown text-sm leading-relaxed">
      {content}
      {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-[var(--ink-accent-approval)] align-middle" />}
    </div>
  );
}

function ThinkingCard({ entry }: { entry: MessageEntry }) {
  const [open, setOpen] = useState(true);
  const duration = entry.meta?.duration as number | undefined;
  return (
    <div className="ink-status-card rounded-xl p-3">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-xs ink-text-muted">
        <Zap size={12} strokeWidth={1.5} />
        <span>思考</span>
        {duration != null && <span>· {duration.toFixed(1)}s</span>}
        <span className="ml-auto">{open ? '收起' : '展开'}</span>
      </button>
      {open && entry.content && (
        <div className="mt-2 ink-status-bubble rounded-lg p-3 text-xs leading-relaxed">{entry.content}</div>
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
      <div className="flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 rounded-full ${isError ? 'bg-[var(--ink-status-warn)]' : status === 'ok' ? 'bg-[var(--ink-status-ok)]' : 'bg-[var(--ink-status-running)] animate-pulse'}`} />
        <span className="font-medium">{toolName}</span>
        <span className="ink-text-faint">· {entry.meta?.summary as string || ''}</span>
        {entry.meta?.duration != null && <span className="ink-text-faint">· {(entry.meta.duration as number).toFixed(2)}s</span>}
        <button type="button" onClick={() => setExpanded(!expanded)} className="ml-auto text-[10px] ink-text-muted hover:text-[var(--ink-text-base)]">
          {expanded ? '收起' : '查看输出'}
        </button>
      </div>
      {isError && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--ink-status-warn)]">
          <AlertTriangle size={12} strokeWidth={1.5} />
          <span>失败 · {errorReason || '执行异常'}</span>
        </div>
      )}
      {expanded && (
        <div className="mt-2">
          <pre className="max-h-60 overflow-auto rounded-lg bg-[var(--ink-bg-surface)] p-3 text-xs">{output}</pre>
          {output.length > 120 && (
            <button type="button" onClick={() => onExpand(`${toolName} 完整输出`, output)} className="mt-2 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)]">
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
    const color = confidence && confidence >= 0.8 ? 'bg-[var(--ink-status-ok)]' : confidence && confidence >= 0.5 ? 'bg-[var(--ink-status-warn)]' : 'bg-[var(--ink-status-pending)]';
    return (
      <div className="ink-status-card flex items-center gap-2 rounded-xl px-3 py-2 text-xs">
        <span className={`h-2 w-2 rounded-full ${color}`} />
        <span>知识检索 · 已放行 · {entry.meta?.count as number || 0} 条相关记忆</span>
        {confidence != null && <span className="ink-text-faint">可信度 {confidence.toFixed(2)}</span>}
      </div>
    );
  }
  if (kind === 'review') {
    const verdict = entry.meta?.verdict as string | undefined;
    const color = verdict === 'pass' ? 'text-[var(--ink-status-ok)]' : verdict === 'fail' ? 'text-[var(--ink-status-warn)]' : 'text-[var(--ink-status-pending)]';
    return (
      <div className="ink-status-card flex items-center gap-2 rounded-xl px-3 py-2 text-xs">
        <CheckCircle2 size={12} strokeWidth={1.5} className={color} />
        <span>评审 · {verdict === 'pass' ? '通过' : verdict === 'fail' ? '未通过' : '观察中'}</span>
      </div>
    );
  }
  return (
    <div className="ink-status-card rounded-xl px-3 py-2 text-xs ink-text-muted">
      {entry.content || '事件'}
    </div>
  );
}

function SpawnCard({ entry, onOpenPanel }: { entry: MessageEntry; onOpenPanel: () => void }) {
  const count = (entry.meta?.count as number) || 0;
  return (
    <div className="ink-status-card rounded-xl p-3">
      <div className="flex items-center gap-2 text-xs">
        <Zap size={12} strokeWidth={1.5} className="text-[var(--ink-status-running)]" />
        <span className="font-medium">子代理 · {count} 个实例</span>
        <span className="ink-text-faint">并行执行中</span>
        <button type="button" onClick={onOpenPanel} className="ml-auto text-[10px] ink-text-muted hover:text-[var(--ink-text-base)]">
          打开面板
        </button>
      </div>
      <div className="mt-2 space-y-1 pl-4">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 text-xs ink-text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--ink-status-running)] animate-pulse" />
            <span>实例 {i + 1}</span>
            <span className="ink-text-faint">· 执行中</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorCard({ entry }: { entry: MessageEntry }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-[var(--ink-status-warn)] bg-[var(--ink-bg-surface)] px-3 py-2 text-xs text-[var(--ink-status-warn)]">
      <XCircle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" />
      <div>
        <p className="font-medium">错误</p>
        <p className="mt-0.5 ink-text-muted">{entry.content || '未知错误'}</p>
      </div>
    </div>
  );
}

function SystemLine({ entry }: { entry: MessageEntry }) {
  return (
    <div className="flex items-center gap-2 text-xs ink-text-faint">
      <Clock size={12} strokeWidth={1.5} />
      <span>{entry.content || '系统消息'}</span>
    </div>
  );
}
