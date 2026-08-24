/**
 * 路径装配审计渲染器（汇流裁决/指纹顶替/策略边复审）：events 通道的
 * 三张透明状态卡片 + 注册入口。
 *
 * 三类审计负载形态 = 引擎事件类型的登记骨架（时间戳/域/指纹等公共
 * 字段 + 各类型专属字段）；呈现纪律：折叠展示人话摘要（裁决结论/
 * 顶替方向/复审处置），展开详情展示原样负载（透明语义——审计留痕
 * 不加工、不修剪，正文可读）。
 *
 * 注册入口：registerAssemblyAuditRenderers() 登记
 * 「junction_audit_card」「fingerprint_replace_audit_card」
 * 「policy_edge_review_audit_card」三组件（接入点 = 渲染器加载处，
 * 随动态组件注册表白名单放行——主会话按加载点合入，本文件不改
 * 注册表）。
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Fingerprint, GitMerge, ShieldAlert } from 'lucide-react';

import type { HubEvent } from '@/shared/session/channelHub';
import { registerComponent } from './componentRegistry';

interface AuditRaw {
  ts?: number;
  domain?: string;
  fingerprint?: string;
  [key: string]: unknown;
}

function formatTime(at?: number): string {
  if (!at) return '--:--:--';
  return new Date(at).toLocaleTimeString();
}

/** 可展开详情区（折叠默认收起；人话摘要行 + 原样负载）。 */
function AuditDetails({
  expanded,
  onToggle,
  summary,
  payload,
}: {
  expanded: boolean;
  onToggle: () => void;
  summary: string;
  payload: AuditRaw;
}) {
  return (
    <div className="border-t border-dashed ink-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3.5 py-1.5 text-left text-[10px] ink-text-muted hover:ink-text-base"
      >
        {expanded ? (
          <ChevronDown size={11} strokeWidth={1.6} aria-hidden />
        ) : (
          <ChevronRight size={11} strokeWidth={1.6} aria-hidden />
        )}
        <span className="min-w-0 truncate">{summary}</span>
      </button>
      {expanded ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3.5 pb-2.5 text-[10px] leading-relaxed ink-text-muted">
          {JSON.stringify(payload, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

/** 审计卡片壳（透明状态卡片：无填充描边一笔，共用头部/详情区）。 */
function AuditCardShell({
  icon,
  title,
  note,
  bindValue,
  summary,
}: {
  icon: React.ReactNode;
  title: string;
  note: string;
  bindValue?: unknown;
  summary: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const payload = ((bindValue as HubEvent | undefined)?.payload ?? {}) as AuditRaw;
  return (
    <section className="ink-panel p-0">
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <span className="ink-icon-chip">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold tracking-tight">{title}</span>
            <span className="text-[10px] ink-text-faint">{note}</span>
            {payload.domain ? (
              <span className="ml-auto rounded-md px-1.5 py-px text-[9px] ink-elevated">
                {payload.domain}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-[10px] leading-relaxed ink-text-muted">
            {summary}
            <span className="ml-1.5">{formatTime(payload.ts)}</span>
          </div>
        </div>
      </div>
      <AuditDetails expanded={expanded} onToggle={() => setExpanded((v) => !v)} summary="审计详情（原样负载）" payload={payload} />
    </section>
  );
}

/** 汇流裁决留痕：多径汇流点的结论（同过者比信任档/成本，跨域走合成）。 */
export function JunctionAuditCard({ bindValue }: { bindValue?: unknown }) {
  const payload = ((bindValue as HubEvent | undefined)?.payload ?? {}) as AuditRaw & {
    winner?: string;
    chosen?: string;
    verdict?: string;
  };
  const verdict =
    payload.winner ?? payload.chosen ?? payload.verdict ?? '（裁决结论见详情）';
  return (
    <AuditCardShell
      icon={<GitMerge size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
      title="汇流裁决"
      note="多径汇流留痕"
      bindValue={bindValue}
      summary={`胜出：${verdict}`}
    />
  );
}

/** 指纹顶替留痕：上下文指纹缓存条目失效与新条目落位。 */
export function FingerprintReplaceAuditCard({ bindValue }: { bindValue?: unknown }) {
  const payload = ((bindValue as HubEvent | undefined)?.payload ?? {}) as AuditRaw;
  const fingerprint = payload.fingerprint ?? '（未登记指纹）';
  return (
    <AuditCardShell
      icon={<Fingerprint size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
      title="指纹顶替"
      note="缓存条目失效/落位留痕"
      bindValue={bindValue}
      summary={`指纹：${fingerprint}`}
    />
  );
}

/** 策略边复审留痕：对抗证据触发人工复审（复审前降级为普通统计边）。 */
export function PolicyEdgeReviewAuditCard({ bindValue }: { bindValue?: unknown }) {
  const payload = ((bindValue as HubEvent | undefined)?.payload ?? {}) as AuditRaw & {
    edge?: string;
    src?: string;
    dst?: string;
    verdict?: string;
  };
  const edge = payload.edge ?? (payload.src && payload.dst ? `${payload.src} → ${payload.dst}` : '（未登记边）');
  const verdict = payload.verdict ?? '（复审处置见详情）';
  return (
    <AuditCardShell
      icon={<ShieldAlert size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />}
      title="策略边复审"
      note="对抗证据提请人工复审"
      bindValue={bindValue}
      summary={`${edge} · ${verdict}`}
    />
  );
}

/** 注册入口：三类路径装配审计卡片进动态组件注册表（同名覆盖幂等）。 */
export function registerAssemblyAuditRenderers(): void {
  registerComponent('junction_audit_card', JunctionAuditCard);
  registerComponent('fingerprint_replace_audit_card', FingerprintReplaceAuditCard);
  registerComponent('policy_edge_review_audit_card', PolicyEdgeReviewAuditCard);
}
