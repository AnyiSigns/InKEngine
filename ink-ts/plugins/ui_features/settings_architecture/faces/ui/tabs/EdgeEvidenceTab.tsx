import { useEffect, useState } from 'react';
import { GitMerge } from 'lucide-react';

import { EmptyState } from '@app/views/EmptyState';
import type { ArchitectureBackend, EdgeSnapshotData } from '@app/views/architecture/backend';
import { useT } from '@/i18n/useT';
import styles from '../architecture.module.css';

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
    return <div className={styles.muted} data-testid="edge-loading">{t('edge.loading')}</div>;
  }

  const edges = data.edges ?? [];

  if (data.available === false || edges.length === 0) {
    return <EmptyState icon={GitMerge} text={t('edge.empty')} />;
  }

  return (
    <div className={styles.stack} data-tab="edge">
      <div className={styles.panel}>
        <div className={styles.panelTitle}>{t('edge.trust_tier_header')}</div>
        <div className={styles.muted}>{edges.length} 条边证据（引擎只读投影）</div>
        {edges.map((e) => {
          const id = `${e.src_type} → ${e.dst_type}`;
          return (
            <div key={id} className={styles.rowItem} data-testid={`edge-row-${e.src_type}-${e.dst_type}`}>
              <div className={styles.grow}>
                <div className={styles.truncate}>{id}</div>
                <div className={styles.muted}>
                  域 {e.context_domain} · 成功 {e.success_count} / 失败 {e.fail_count} · 均耗 {e.avg_cost.toFixed(4)}
                </div>
              </div>
              {e.policy ? (
                <span className={`${styles.badge} ${styles.badgeWarn}`} data-testid="edge-policy">策略边</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
