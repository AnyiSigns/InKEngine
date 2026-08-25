/**
 * 干预卡：候选选择 / 缓存清除 / 信任档降级 / 多路展开 四入口。
 *
 * 每个操作对应一个壳侧 op 契约（path.choose_candidate / cache.invalidate /
 * edge.downgrade_tier / path.set_multipath 复用 path.set_flags）：调用经
 * 可注入后端适配器下发，成功后向通道中枢投审计事件（留痕展示），并维护
 * 本地状态；反向操作复原状态并投反向审计事件。无宿主回落：调用落到
 * mock 后端（测试注入），审计留痕照常展示。
 */

import { useState } from 'react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { ChannelHub, HubEvent } from '@/shared/session/channelHub';
import type { EventTypeName } from '@/shared/session/eventTypes';
import { getBindSource } from '@/renderer/bindSource';
import { Button } from '@/shared/ui/Button';

export interface InterventionCandidate {
  id: string;
  label: string;
}

export interface InterventionCardProps {
  candidate?: InterventionCandidate;
  edgeId?: string;
  cacheScope?: string;
  /** 可注入后端（缺省 = 全局后端选择） */
  backend?: BackendAdapter;
  /** 可注入通道中枢（审计事件投送；缺省 = 渲染上下文） */
  hub?: ChannelHub;
}

interface AuditEntry {
  type: string;
  at: number;
}

function auditType(s: string): EventTypeName {
  return s as EventTypeName;
}

export function InterventionCard({
  candidate,
  edgeId = 'edge-1',
  cacheScope = 'default',
  backend,
  hub: hubProp,
}: InterventionCardProps) {
  const resolvedBackend = backend;
  const hub = hubProp ?? getBindSource()?.hub ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [multipath, setMultipath] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [edgeDowngraded, setEdgeDowngraded] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  const record = (type: string): void => {
    setAudit((list) => [...list, { type, at: Date.now() }]);
    if (hub) {
      const event: HubEvent = { type: auditType(type), payload: { op: type }, at: Date.now() };
      hub.dispatch(event);
    }
  };

  const choose = async (): Promise<void> => {
    if (!candidate || !resolvedBackend) return;
    await resolvedBackend.chooseCandidate(candidate.id);
    setSelectedId(candidate.id);
    record('path_choose_candidate');
  };
  const clearChoice = async (): Promise<void> => {
    if (!resolvedBackend) return;
    await resolvedBackend.chooseCandidate(null);
    setSelectedId(null);
    record('path_choose_candidate_cleared');
  };

  const toggleMultipath = async (): Promise<void> => {
    if (!resolvedBackend) return;
    const next = !multipath;
    await resolvedBackend.setMultipath(next);
    setMultipath(next);
    record('path_set_multipath');
  };

  const clearCache = async (): Promise<void> => {
    if (!resolvedBackend) return;
    await resolvedBackend.invalidateCache(cacheScope);
    setCacheCleared(true);
    record('cache_invalidate');
  };
  const rebuild = async (): Promise<void> => {
    if (!resolvedBackend) return;
    await resolvedBackend.rebuildCache(cacheScope);
    setCacheCleared(false);
    record('cache_rebuild');
  };

  const downgrade = async (): Promise<void> => {
    if (!resolvedBackend) return;
    await resolvedBackend.downgradeEdgeTier(edgeId);
    setEdgeDowngraded(true);
    record('edge_downgrade_tier');
  };
  const restoreEdge = async (): Promise<void> => {
    if (!resolvedBackend) return;
    await resolvedBackend.restoreEdgeTier(edgeId);
    setEdgeDowngraded(false);
    record('edge_restore_tier');
  };

  return (
    <section className="ink-panel p-3" data-ui="intervention_card">
      <div className="text-[12px] font-semibold tracking-tight">干预</div>

      {candidate ? (
        <div className="mt-2 rounded-md border ink-border px-2 py-1.5" data-ui="candidate">
          <div className="text-[11px] ink-text-base">{candidate.label}</div>
          <div className="mt-1 flex gap-1.5">
            <Button
              size="xs"
              variant="primary"
              data-ui="btn_choose"
              disabled={selectedId === candidate.id}
              onClick={() => void choose()}
            >
              选这条
            </Button>
            <Button
              size="xs"
              variant="ghost"
              data-ui="btn_clear_choice"
              disabled={selectedId !== candidate.id}
              onClick={() => void clearChoice()}
            >
              取消选择
            </Button>
          </div>
          {selectedId === candidate.id ? (
            <div className="mt-1 text-[9px] ink-accent" data-ui="choose_state">已选</div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="xs" variant="secondary" data-ui="btn_multipath" onClick={() => void toggleMultipath()}>
          {multipath ? '多路：开' : '多路：关'}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          data-ui="btn_cache"
          disabled={cacheCleared}
          onClick={() => void clearCache()}
        >
          清除缓存
        </Button>
        <Button
          size="xs"
          variant="ghost"
          data-ui="btn_cache_rebuild"
          disabled={!cacheCleared}
          onClick={() => void rebuild()}
        >
          重建缓存
        </Button>
        <Button
          size="xs"
          variant="secondary"
          data-ui="btn_edge"
          disabled={edgeDowngraded}
          onClick={() => void downgrade()}
        >
          信任档降级
        </Button>
        <Button
          size="xs"
          variant="ghost"
          data-ui="btn_edge_restore"
          disabled={!edgeDowngraded}
          onClick={() => void restoreEdge()}
        >
          恢复信任档
        </Button>
      </div>

      {audit.length > 0 ? (
        <ul className="mt-2 space-y-0.5" data-ui="audit_trail">
          {audit.map((entry, index) => (
            <li key={index} data-ui="audit_entry" data-op={entry.type} className="text-[9px] ink-text-faint">
              {entry.type}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
