/**
 * 组装候选留痕渲染器：events.assembly_candidate 通道的面板组件 + 注册入口。
 *
 * 事件负载 = 组装审计记录（时间戳/域/指纹 + 候选清单）；候选 = 图定义
 * 数据（rank/source/repaired/score/chain）。呈现纪律沿「状态卡片透明」
 * 语义：卡片无填充（仅描边一笔），正文不透明、元信息折叠展开——
 * 折叠展示人话摘要（域/候选数/覆盖字段），展开看候选链与统计明细。
 *
 * 注册入口：registerPathAssemblyRenderers() 登记
 * 「assembly_candidate_card」组件（接入点 = 渲染器加载处，随动态
 * 组件注册表白名单放行——主会话按加载点合入，本文件不改注册表）。
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';

import type { HubEvent } from '@/shared/session/channelHub';
import { registerComponent } from './componentRegistry';

/** 候选条目（图定义数据形态；未知字段容忍，渲染只取已约定键）。 */
interface AssemblyCandidatePayload {
  rank?: number;
  source?: string;
  repaired?: boolean;
  score?: number;
  chain?: string[];
  graph?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 组装候选事件负载（审计记录形态）。 */
interface AssemblyCandidateEventPayload {
  ts?: number;
  domain?: string;
  fingerprint?: string;
  goal_fields?: string[];
  entry_fields?: string[];
  candidates?: AssemblyCandidatePayload[];
  llm_attempts?: number;
  fallback_reason?: string | null;
  stats?: Record<string, unknown>;
  [key: string]: unknown;
}

const SOURCE_LABELS: Record<string, string> = {
  algorithm: '算法反推',
  draft: '草稿',
};

function formatTime(at?: number): string {
  if (!at) return '--';
  return new Date(at).toLocaleTimeString();
}

function chainText(chain?: string[]): string {
  if (!chain || chain.length === 0) return '（空链）';
  return chain.join(' → ');
}

/** 折叠区通用形态：摘要行 + 可展开详情。 */
function Collapsible({
  summary,
  expanded,
  onToggle,
  children,
}: {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-dashed ink-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[10px] ink-text-muted hover:ink-text-base"
      >
        {expanded ? (
          <ChevronDown size={11} strokeWidth={1.6} aria-hidden />
        ) : (
          <ChevronRight size={11} strokeWidth={1.6} aria-hidden />
        )}
        <span className="min-w-0 truncate">{summary}</span>
      </button>
      {expanded ? <div className="border-t border-dashed ink-border px-3 py-2">{children}</div> : null}
    </div>
  );
}

/** 组装候选留痕卡片（透明状态卡片：无填充描边一笔 + 折叠展开）。 */
export function AssemblyCandidateCard({ bindValue }: { bindValue?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const event = bindValue as HubEvent | undefined;
  const payload = (event?.payload ?? {}) as AssemblyCandidateEventPayload;
  const candidates = payload.candidates ?? [];

  return (
    <section className="ink-panel p-0">
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <span className="ink-icon-chip">
          <GitBranch size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold tracking-tight">组装候选</span>
            <span className="text-[10px] ink-text-faint">候选计划仅供观察</span>
            {payload.domain ? (
              <span className="ml-auto rounded-md px-1.5 py-px text-[9px] ink-elevated">
                {payload.domain}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-[10px] leading-relaxed ink-text-muted">
            {candidates.length === 0 ? '暂无候选（未组装或未解出目标覆盖链）' : `候选 ${candidates.length} 条`}
            <span className="ml-1.5">{formatTime(payload.ts ?? event?.at)}</span>
          </div>
          {payload.fallback_reason ? (
            <div className="mt-1 text-[10px] ink-accent">兜底：{payload.fallback_reason}</div>
          ) : null}
        </div>
      </div>

      {candidates.length > 0 ? (
        <Collapsible
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          summary={`候选明细 · ${candidates[0]?.rank ?? 1} 号 ${chainText(candidates[0]?.chain)}`}
        >
          <div className="space-y-2">
            {candidates.map((candidate, index) => (
              <div key={index} className="ink-elevated px-3 py-2">
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="rounded-md px-1.5 py-px ink-text-muted">
                    第 {candidate.rank ?? index + 1} 名
                  </span>
                  <span>{SOURCE_LABELS[candidate.source ?? ''] ?? candidate.source ?? '未知来源'}</span>
                  {candidate.repaired ? (
                    <span className="text-[9px] ink-text-faint">（修复修形）</span>
                  ) : null}
                  <span className="ml-auto text-[9px] ink-text-faint">
                    评分 {(candidate.score ?? 0).toFixed(4)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] leading-relaxed">{chainText(candidate.chain)}</div>
              </div>
            ))}
            <div className="text-[10px] leading-relaxed ink-text-muted">
              <span>目标覆盖：{payload.goal_fields?.join('、') ?? '—'}</span>
              <span className="ml-2">入口字段：{payload.entry_fields?.join('、') ?? '（无）'}</span>
            </div>
            {payload.stats && Object.keys(payload.stats).length > 0 ? (
              <div className="text-[10px] leading-relaxed ink-text-faint">
                统计：{JSON.stringify(payload.stats)}
              </div>
            ) : null}
          </div>
        </Collapsible>
      ) : null}
    </section>
  );
}

/** 注册入口：组装候选留痕组件进动态组件注册表（同名覆盖幂等）。 */
export function registerPathAssemblyRenderers(): void {
  registerComponent('assembly_candidate_card', AssemblyCandidateCard);
}
