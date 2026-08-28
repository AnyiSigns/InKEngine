/**
 * 演化页（主区「演化」页签）：自学习演化动态时间线。
 *
 * 复用轨迹页的纵向时间线视觉（左侧状态点 + 右侧内容 + 指标行），
 * 数据 = hub 实时归约快照：
 * - incubation 孵化流水：信号检测 → 蒸馏 → 闸门判定（passed/blocked）
 * - patchChain 补丁链：提案 → 应用 / 回退
 * 不建独立侧边栏、不依赖 w3 mock backend——普通用户看到的就是
 * 「智能体如何自我调整」的紧凑时间线。
 */

import { CheckCircle2, Circle, GitCommitVertical, Loader2, ShieldAlert, Sparkles, XCircle } from 'lucide-react';

import type { IncubationEntry, PatchChainEntry } from '@/shared/session/types';

interface EvolutionFeedProps {
  incubation: IncubationEntry[];
  patchChain: PatchChainEntry[];
}

/** 孵化条目 → 时间线节点（状态点 + 标题 + 细节）。 */
function incubationNode(entry: IncubationEntry): { icon: JSX.Element; label: string; note?: string; status?: string } {
  switch (entry.stage) {
    case 'signal':
      return { icon: <Circle size={14} strokeWidth={1.6} className="ink-text-faint" />, label: `信号 · ${entry.signalType || entry.signal}`, status: '待蒸馏' };
    case 'distilling':
      return { icon: <Loader2 size={14} strokeWidth={1.6} className="animate-spin ink-text-muted" />, label: `蒸馏中 · ${entry.signalType}`, status: '蒸馏中' };
    case 'distilled':
      return { icon: <Sparkles size={14} strokeWidth={1.6} className="ink-text-muted" />, label: entry.distilled || `蒸馏产物 · ${entry.signalType}`, note: entry.signal, status: '已蒸馏' };
    case 'gating':
      return { icon: <Loader2 size={14} strokeWidth={1.6} className="animate-spin ink-text-muted" />, label: `闸门校验 · ${entry.gateLevel ?? ''}`, status: '校验中' };
    case 'passed':
      return { icon: <CheckCircle2 size={14} strokeWidth={1.6} className="ink-text-muted" />, label: `已放行 · ${entry.signalType}`, note: entry.verdict, status: '已放行' };
    case 'blocked':
      return { icon: <XCircle size={14} strokeWidth={1.6} className="ink-accent" />, label: `已拦截 · ${entry.signalType}`, note: entry.verdict, status: '已拦截' };
    default:
      return { icon: <Circle size={14} strokeWidth={1.6} className="ink-text-faint" />, label: entry.signal, status: '信号' };
  }
}

/** 补丁链条目 → 时间线节点。 */
function patchNode(entry: PatchChainEntry): { icon: JSX.Element; label: string; note?: string; status?: string } {
  switch (entry.status) {
    case 'proposed':
      return { icon: <GitCommitVertical size={14} strokeWidth={1.6} className="ink-text-faint" />, label: `补丁提案 · ${entry.title}`, note: entry.level ? `级别 ${entry.level}` : undefined, status: '待评审' };
    case 'applied':
      return { icon: <CheckCircle2 size={14} strokeWidth={1.6} className="ink-text-muted" />, label: `已应用 · ${entry.title}`, status: '已应用' };
    case 'reverted':
      return { icon: <ShieldAlert size={14} strokeWidth={1.6} className="ink-accent" />, label: `已回退 · ${entry.title}`, note: entry.revertReason, status: '已回退' };
    default:
      return { icon: <GitCommitVertical size={14} strokeWidth={1.6} className="ink-text-faint" />, label: entry.title, status: entry.status };
  }
}

export function EvolutionFeed({ incubation, patchChain }: EvolutionFeedProps): JSX.Element {
  const signalCount = incubation.filter((e) => e.stage === 'passed').length + incubation.filter((e) => e.stage === 'blocked').length;
  const blockedCount = incubation.filter((e) => e.stage === 'blocked').length;

  if (incubation.length === 0 && patchChain.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-[12px] ink-text-faint">
        <p>还没有演化动态</p>
        <p className="text-[11px]">会话运行后，这里会展示智能体的自学习演化时间线</p>
      </div>
    );
  }

  return (
    <div className="ink-scroll-auto flex-1 overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 flex items-baseline gap-3">
          <span className="text-[13px] font-medium">演化动态</span>
          <span className="text-[11px] ink-text-faint">
            {incubation.length} 条孵化{signalCount > 0 ? ` · ${signalCount} 条已判定` : ''}{blockedCount > 0 ? ` · ${blockedCount} 条被拦截` : ''}
            {patchChain.length > 0 ? ` · ${patchChain.length} 条补丁` : ''}
          </span>
        </div>
        <ol className="relative space-y-1 border-l ink-border pl-5">
          {patchChain.map((entry) => {
            const node = patchNode(entry);
            return (
              <li key={entry.patchId} className="relative flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-[var(--ink-bg-surface)]">
                <span className="absolute -left-[26px] top-2.5 flex h-4 w-4 items-center justify-center bg-[var(--ink-bg-base)]">
                  {node.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px]">{node.label}</span>
                    {node.status && <span className="shrink-0 text-[11px] ink-text-faint">{node.status}</span>}
                  </div>
                  {node.note && <p className="mt-0.5 text-[11px] leading-relaxed ink-text-muted">{node.note}</p>}
                </div>
              </li>
            );
          })}
          {incubation.map((entry) => {
            const node = incubationNode(entry);
            return (
              <li key={entry.id} className="relative flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-[var(--ink-bg-surface)]">
                <span className="absolute -left-[26px] top-2.5 flex h-4 w-4 items-center justify-center bg-[var(--ink-bg-base)]">
                  {node.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px]">{node.label}</span>
                    {node.status && <span className="shrink-0 text-[11px] ink-text-faint">{node.status}</span>}
                  </div>
                  {node.note && <p className="mt-0.5 text-[11px] leading-relaxed ink-text-muted">{node.note}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
