import { useEffect, useState } from 'react';
import { GitMerge } from 'lucide-react';

import { EmptyState } from '@app/views/EmptyState';
import type { ArchitectureBackend, EdgeSnapshotData } from '@app/views/architecture/backend';
import { useT } from '@/i18n/useT';

/** 边证据 tab：edge_evidence.list 只读窗口（src→dst 契约证据行 + 计数）。 */
export function EdgeEvidenceTab({ backend }: { backend: ArchitectureBackend }) {
  const { t } = useT();
  const [data, setData] = useState<EdgeSnapshotData | null>(null);

  const load = async (): Promise<void> => {
    setData(await backend.fetchEdgeEvidence());
  };

  useEffect(() => {
    void load();
  }, [backend]);

  if (data === null) {
    return <div className="w3-muted" data-testid="edge-loading">{t('edge.loading')}</div>;
  }

  const edges = data.edges ?? [];

  if (data.available === false || edges.length === 0) {
    return <EmptyState icon={GitMerge} text={t('edge.empty')} />;
  }

  return (
    <div className="w3-stack" data-tab="edge">
      <div className="w3-panel">
        <div className="w3-panel-title">{t('edge.trust_tier_header')}</div>
        <div className="w3-muted">{edges.length} 条边证据（引擎只读投影）</div>
        {edges.map((e) => {
          const id = `${e.src_type} → ${e.dst_type}`;
          return (
            <div key={id} className="w3-row-item" data-testid={`edge-row-${e.src_type}-${e.dst_type}`}>
              <div className="w3-grow">
                <div className="w3-truncate">{id}</div>
                <div className="w3-muted">
                  域 {e.context_domain} · 成功 {e.success_count} / 失败 {e.fail_count} · 均耗 {e.avg_cost.toFixed(4)}
                </div>
              </div>
              {e.policy ? (
                <span className="w3-badge w3-badge--warn" data-testid="edge-policy">策略边</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
