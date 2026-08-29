/**
 * 事件调度器（事件 → 渲染组件的映射面）。
 *
 * 每个事件类型映射到对应的渲染器组件：子代理/推演/工具/思考/流式正文/
 * 回合结束/审批/错误。未知事件类型走兜底卡（「新事件类型 · 暂不支持
 * 渲染」+ 复制原始事件），绝不因新事件类型而崩溃。渲染器只消费事件
 * 负载，展示词经翻译表转中文，机器词保留在原文行供对账。
 */

import { useState } from 'react';

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Copy,
  Cpu,
  GitBranch,
  Loader2,
  Route,
  Square,
  Wrench,
} from 'lucide-react';

import { cn } from '@/shared/cn';
import type { HubEvent } from '@/shared/session/channelHub';
import { permissionLabel, resolveToolLabel, toolStatusLabel } from '@/shared/labels/toolLabels';
import { t } from '@/app/texts/translations';

function eventString(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

function eventNumber(payload: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/** 事件卡片外壳：图标 + 中文标题 + 状态行。 */
function EventShell({
  icon,
  title,
  statusText,
  running,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  statusText?: string;
  running?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="ink-status-card px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="ink-icon-chip h-6 w-6">{icon}</span>
        <span className="text-[var(--ink-font-xs)] font-medium">{title}</span>
        {statusText ? (
          <span
            className={cn(
              'ink-chip py-px text-[9px]',
              running ? 'ink-text-muted' : 'ink-text-faint',
            )}
          >
            {running && <span className="ink-live-dot" aria-hidden />}
            {statusText}
          </span>
        ) : null}
      </div>
      {children ? <div className="mt-2 space-y-1">{children}</div> : null}
    </div>
  );
}

/** 子代理卡：子代理 × N + 实例行（序号/标题/状态点/耗时）。 */
function SpawnCard({ event }: { event: HubEvent }) {
  const running = event.type === 'spawn_start';
  const payload = event.payload;
  const label = eventString(payload, 'label', 'title') || '子代理';
  const instances = Array.isArray(payload.instances)
    ? (payload.instances as Array<Record<string, unknown>>)
    : [];
  const count = eventNumber(payload, 'count', 'total') ?? instances.length ?? 1;
  const statusText = running ? '并行执行中' : '已完成';
  return (
    <EventShell
      icon={<GitBranch size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
      title={`${label} × ${count}`}
      statusText={statusText}
      running={running}
    >
      {instances.map((instance, index) => {
        const title = String(instance.title ?? instance.label ?? `实例 ${index + 1}`);
        const state = String(instance.status ?? (running ? 'running' : 'done'));
        const elapsedMs = eventNumber(instance, 'elapsed_ms', 'duration_ms');
        return (
          <div key={`spawn-${index}`} className="flex items-center gap-2 text-[10px]">
            <span className="ink-text-faint">#{index + 1}</span>
            <span className="min-w-0 flex-1 truncate ink-text-muted">{title}</span>
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full bg-current',
                state === 'running' ? 'ink-text-muted ink-live-dot' : 'ink-text-faint',
              )}
              aria-hidden
            />
            {elapsedMs !== undefined ? <span className="ink-text-faint">{Math.round(elapsedMs)}ms</span> : null}
            <span className="font-mono text-[9px] ink-text-faint">:spawn:{index}</span>
          </div>
        );
      })}
    </EventShell>
  );
}

/** 推演树卡（机制波提供完整树；此处为自包含回落形态：分支 + 选中标记）。 */
function SimulationCard({ event }: { event: HubEvent }) {
  const payload = event.payload;
  const branches = Array.isArray(payload.branches)
    ? (payload.branches as Array<Record<string, unknown>>)
    : [];
  if (branches.length === 0) {
    const branchId = eventString(payload, 'branch_id', 'branch');
    const score = eventNumber(payload, 'score');
    return (
      <EventShell
        icon={<Route size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
        title={t('simulate_decision')}
      >
        <div className="flex items-center gap-2 text-[10px]">
          <span className="ink-text-muted">{branchId || '分支'}</span>
          {score !== undefined ? <span className="ink-text-faint">评分 {score}</span> : null}
        </div>
      </EventShell>
    );
  }
  return (
    <EventShell
      icon={<Route size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
      title={t('simulate_decision')}
    >
      {branches.map((branch, index) => {
        const id = String(branch.branch_id ?? `b${index + 1}`);
        const label = String(branch.label ?? `分支 ${index + 1}`);
        const selected = branch.selected === true || index === 0;
        const score = eventNumber(branch, 'score');
        return (
          <div key={id} className="flex items-center gap-2 text-[10px]">
            <span className={cn('h-1.5 w-1.5 rounded-full bg-current', selected ? 'ink-text-base' : 'ink-text-faint')} aria-hidden />
            <span className={cn('min-w-0 flex-1 truncate', selected ? 'ink-text-base' : 'ink-text-muted')}>{label}</span>
            {score !== undefined ? <span className="ink-text-faint">评分 {score}</span> : null}
            {selected ? <span className="ink-chip py-px text-[9px] ink-text-faint">选中</span> : null}
          </div>
        );
      })}
    </EventShell>
  );
}

/** 工具卡：中文名 + 权限档 + 参数摘要。 */
function ToolCard({ event }: { event: HubEvent }) {
  const payload = event.payload;
  const tool = eventString(payload, 'tool', 'tool_name');
  const title = eventString(payload, 'title', 'label');
  const permission = eventString(payload, 'permission');
  const summary = eventString(payload, 'summary', 'result_preview', 'result');
  const running = event.type === 'tool_start';
  const failed = event.type === 'tool_end' && payload.success === false;
  const label = resolveToolLabel({ tool, title });
  const statusText = running ? '进行中' : failed ? '失败' : '完成';
  return (
    <EventShell
      icon={<Wrench size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
      title={label}
      statusText={statusText}
      running={running}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
        <span className="font-mono ink-text-faint">{tool}</span>
        {permission ? <span className="ink-text-muted">{permissionLabel(permission)}</span> : null}
        {summary ? <span className="min-w-0 truncate ink-text-muted">{summary}</span> : null}
      </div>
    </EventShell>
  );
}

/** 思考条目卡：状态 + 内容分片。 */
function ThinkingCard({ event }: { event: HubEvent }) {
  const running = event.type === 'thinking_start';
  const payload = event.payload;
  const content = eventString(payload, 'content');
  return (
    <EventShell
      icon={<Cpu size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
      title="思考"
      statusText={running ? '推理中' : '已完成'}
      running={running}
    >
      <div className="whitespace-pre-wrap break-words text-[10px] leading-[1.7] ink-text-muted">
        {content || (running ? '（推理中…）' : '—')}
        {running && <span className="ink-caret-muted" aria-hidden />}
      </div>
    </EventShell>
  );
}

/** 流式正文：token 片段的增量呈现（带呼吸光标）。 */
function StreamingText({ event }: { event: HubEvent }) {
  const token = String(event.payload.token ?? '');
  return (
    <div className="flex items-start gap-1.5 text-[var(--ink-font-xs)]">
      <Bot size={12} strokeWidth={1.6} className="mt-0.5 shrink-0 ink-text-faint" aria-hidden />
      <span className="whitespace-pre-wrap break-words">{token}<span className="ink-caret-muted" aria-hidden /></span>
    </div>
  );
}

/** 回合结束信号：结束原因 + 输出摘要。 */
function RoundEndSignal({ event }: { event: HubEvent }) {
  const payload = event.payload;
  const reason = eventString(payload, 'reason', 'summary');
  const output = eventString(payload, 'output');
  return (
    <EventShell
      icon={<CheckCircle2 size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
      title="回合结束"
    >
      {reason ? <div className="text-[10px] ink-text-muted">{reason}</div> : null}
      {output ? <div className="whitespace-pre-wrap break-words text-[10px] ink-text-faint">{output}</div> : null}
    </EventShell>
  );
}

/** 审批卡（事件面只读快照：裁决徽标）。 */
function ReviewCard({ event }: { event: HubEvent }) {
  const payload = event.payload;
  const title = eventString(payload, 'title', 'key', 'action');
  const verdict = eventString(payload, 'verdict', 'decision');
  const badge = verdict === 'accept' ? '已批准' : verdict === 'reject' ? '已驳回' : '待决议';
  return (
    <EventShell
      icon={<Square size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
      title="审批"
      statusText={badge}
      running={!verdict}
    >
      <div className="text-[10px] ink-text-muted">{title || '审批请求'}</div>
    </EventShell>
  );
}

/** 错误卡。 */
function ErrorCard({ event }: { event: HubEvent }) {
  const message = eventString(event.payload, 'message', 'error');
  return (
    <EventShell
      icon={<AlertTriangle size={12} strokeWidth={1.6} className="ink-accent" aria-hidden />}
      title="错误"
      statusText="失败"
    >
      <div className="whitespace-pre-wrap break-words text-[10px] ink-text-muted">{message || '未知错误'}</div>
    </EventShell>
  );
}

/** 兜底卡：未注册事件类型的折叠呈现 + 复制原始事件。 */
function DefaultFallback({ event }: { event: HubEvent }) {
  const [copied, setCopied] = useState(false);
  const raw = JSON.stringify(event);
  const copyRaw = (): void => {
    void navigator.clipboard?.writeText(raw).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <EventShell
      icon={<Loader2 size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
      title="新事件类型 · 暂不支持渲染"
    >
      <button
        type="button"
        data-ui="event_copy_raw"
        onClick={copyRaw}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] cursor-pointer ink-text-faint hover:text-[var(--ink-text-base)] bg-transparent border-none hover:bg-[var(--ink-bg-elevated)]"
      >
        {copied ? <CheckCircle2 size={10} strokeWidth={1.6} aria-hidden /> : <Copy size={10} strokeWidth={1.6} aria-hidden />}
        {copied ? '已复制' : '复制原始事件'}
      </button>
    </EventShell>
  );
}

/** 事件类型 → 渲染组件（R8 覆盖表；未知类型走兜底）。 */
export function EventRenderer({ event }: { event: HubEvent }): React.JSX.Element {
  switch (event.type) {
    case 'spawn_start':
    case 'spawn_end':
      return <SpawnCard event={event} />;
    case 'simulate_decision':
    case 'branch_result':
    case 'swap_branch':
      return <SimulationCard event={event} />;
    case 'tool_start':
    case 'tool_end':
      return <ToolCard event={event} />;
    case 'thinking_start':
    case 'thinking_end':
      return <ThinkingCard event={event} />;
    case 'reply_token':
      return <StreamingText event={event} />;
    case 'end':
      return <RoundEndSignal event={event} />;
    case 'review_card':
      return <ReviewCard event={event} />;
    case 'error':
      return <ErrorCard event={event} />;
    default:
      return <DefaultFallback event={event} />;
  }
}

/** 事件类型的紧凑中文标签（控制台/事件表对账面）。 */
export function eventTypeLabel(type: string): string {
  const translated = t(type);
  if (translated !== type) return translated;
  const byEvent: Record<string, string> = {
    reply_token: '回复流式',
    thinking_start: '思考开始',
    thinking_end: '思考结束',
    plan_start: '规划开始',
    plan_end: '规划完成',
    tool_start: '工具开始',
    tool_end: '工具完成',
    review_card: '审批卡',
    suggestions: '建议',
    error: '错误',
    end: '回合结束',
    spawn_start: '子代理启动',
    spawn_end: '子代理完成',
    simulate_decision: '推演决策',
    branch_result: '分支评分',
    swap_branch: '换选分支',
    assembly_candidate: '组装候选',
    junction_verdict: '汇流裁决',
    node_start: '节点执行',
    signal_detected: '信号检测',
    distill_outcome: '蒸馏产物',
    gate_verdict: '闸门判定',
    evolution_variant: '进化变异',
    mutation_proposed: '变异提案',
    regression_guard: '防退化守卫',
    patch_proposed: '补丁提案',
    patch_applied: '补丁已应用',
    patch_reverted: '补丁已回退',
    memory_recall: '记忆召回',
    tuning_update: '调优更新',
    vetting_result: '静态核对',
    device_sensed: '设备感知',
    device_control: '设备控制',
  };
  return byEvent[type] ?? type;
}

/** 折叠态行（卡片式事件流使用）：标题 + 展开箭头。 */
export function EventRow({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="ink-status-card px-3.5 py-3">
      <div className="flex items-center gap-2">
        <ChevronRight size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        <span className="text-[var(--ink-font-xs)] font-medium">{title}</span>
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}
