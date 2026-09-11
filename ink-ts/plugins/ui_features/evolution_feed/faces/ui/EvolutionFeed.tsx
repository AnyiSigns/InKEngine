/**
 * 状态页主区（view id = evolution）：自学习演化动态时间线 + 协作者目录。
 *
 * 数据 = hub 实时归约快照 + 引擎只读口：
 * - incubation 孵化流水：信号检测 → 蒸馏 → 闸门判定（passed/blocked）
 * - patchChain 补丁链：提案 → 应用 / 回退
 * - entities 协作者目录：查 entities.snapshot（与 inspect_entities 工具
 *   同源，只读展示可召唤的协作者；无注册表 = 空态不白屏）
 *
 * 「当前回合图组成」段随 graph.instance 组装图投影退役（W7-B）；回合
 * 结构观察面 = 执行树（W7D+ evolution 域 execution 事件流）。
 */

import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, Circle, GitCommitVertical, Loader2, ShieldAlert, Sparkles, XCircle } from 'lucide-react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { IncubationEntry, PatchChainEntry } from '@/shared/session/types';

/** 实体目录快照（与引擎 introspection.snapshot_entities 同构）。 */
interface EntitySnapshotData {
  version: number;
  count: number;
  entities: Array<{
    id: string;
    label: string;
    model: { provider: string; model_id: string } | null;
  }>;
  degraded?: boolean;
}

interface EvolutionFeedProps {
  incubation: IncubationEntry[];
  patchChain: PatchChainEntry[];
  backend: BackendAdapter;
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

export function EvolutionFeed({ incubation, patchChain, backend }: EvolutionFeedProps): JSX.Element {
  const signalCount = incubation.filter((e) => e.stage === 'passed').length + incubation.filter((e) => e.stage === 'blocked').length;
  const blockedCount = incubation.filter((e) => e.stage === 'blocked').length;

  // 协作者目录（entities.snapshot，与 inspect_entities 工具同源；只读展示）
  const [entities, setEntities] = useState<EntitySnapshotData | null>(null);

  useEffect(() => {
    let alive = true;
    if (!backend.available) {
      setEntities(null);
      return;
    }
    void backend
      .entitiesSnapshot()
      .then((raw) => {
        if (alive) setEntities(raw as EntitySnapshotData);
      })
      .catch(() => {
        if (alive) setEntities(null);
      });
    return () => {
      alive = false;
    };
  }, [backend]);

  const hasEntities = Boolean(entities && Array.isArray(entities.entities) && entities.entities.length > 0 && !entities.degraded);

  if (!hasEntities && incubation.length === 0 && patchChain.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-[12px] ink-text-faint">
        <p>还没有演化动态</p>
        <p className="text-[11px]">会话运行后，这里会展示自学习演化动态与协作者目录</p>
      </div>
    );
  }

  return (
    <div className="ink-scroll-auto flex-1 overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-2xl">
        {/* 协作者目录（只读：已注册的协作者清单，模型引用来自 EntitySpec） */}
        {entities && Array.isArray(entities.entities) && entities.entities.length > 0 && !entities.degraded && (
          <div className="mb-5 rounded-xl border ink-border p-4">
            <div className="mb-2 flex items-center gap-2">
              <Bot size={14} strokeWidth={1.6} className="ink-text-faint" />
              <span className="text-[13px] font-medium">协作者目录</span>
              <span className="text-[11px] ink-text-faint">{entities.count} 个协作者 · 只读</span>
            </div>
            <ul className="grid grid-cols-1 gap-2">
              {entities.entities.map((entity) => (
                <li key={entity.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[var(--ink-bg-surface)]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px]">{entity.label || entity.id}</span>
                      {entity.id !== entity.label && <span className="shrink-0 text-[10px] ink-text-faint">{entity.id}</span>}
                    </div>
                  </div>
                  {entity.model && (
                    <span className="ink-chip py-px text-[10px]">
                      {entity.model.provider}/{entity.model.model_id}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* 演化动态时间线 */}
        {(incubation.length > 0 || patchChain.length > 0) && (
          <div>
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
        )}
      </div>
    </div>
  );
}
