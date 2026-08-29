import { useEffect, useState } from 'react';
import { Boxes, Cpu } from 'lucide-react';

import { EmptyState } from '../../EmptyState';
import type { ArchitectureBackend, GovernanceVerdict, PoolGovernance, PoolNode } from '../backend';
import { useT } from '@/i18n/useT';

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

/** 结点池 tab：顶部摘要条 + 结点行 + 最近治理裁决。未接线→降级空态。 */
export function PoolTab({ backend }: { backend: ArchitectureBackend }) {
  const { t } = useT();
  const [data, setData] = useState<{
    governance: PoolGovernance | null;
    nodes: PoolNode[] | null;
    verdicts: GovernanceVerdict[];
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void backend.fetchPool().then((d) => {
      if (!alive) return;
      setData(d);
    });
    return () => {
      alive = false;
    };
  }, [backend]);

  if (data === null) return <div className="w3-muted" data-testid="pool-loading">{t('edge.loading')}</div>;

  const { governance, nodes, verdicts } = data;
  if (!governance && !nodes) {
    return <EmptyState icon={Cpu} text={t('pool.unavailable')} actionLabel={t('pool.connect_hint')} onAction={() => undefined} />;
  }

  return (
    <div className="w3-stack">
      <div className="w3-summary-bar" data-testid="pool-summary">
        <span className="w3-metric">
          <Boxes size={14} strokeWidth={1.5} />
          <strong data-testid="pool-capacity">
            {governance ? `${governance.used}/${governance.total}` : '—'}
          </strong>
          <span>· {governance?.domain ?? t('pool.domain')}</span>
        </span>
        <span className="w3-sep" />
        <span className="w3-metric">
          <strong data-testid="pool-budget">
            {governance ? `${governance.weeklyUsed}/${governance.weeklyTotal}` : '—'}
          </strong>
          <span>· {governance?.weeklyPeriod ?? t('pool.week')}</span>
        </span>
      </div>

      {nodes && nodes.length > 0 && (
        <div className="w3-panel">
          <div className="w3-panel-title">{t('pool.nodes')}</div>
          {nodes.map((n) => (
            <div key={n.name} className="w3-row-item" data-testid={`pool-node-${n.name}`} data-dead={n.dead}>
              <div className="w3-grow">
                <div className="w3-truncate">{n.name}</div>
                <div className="w3-muted">
                  {n.safetyTier} · {n.version} · {interpolate(t('pool.usage'), { n: n.usageCount })}
                </div>
              </div>
              {n.dead && (
                <span className="w3-badge w3-badge--warn" data-testid="pool-dead">
                  {t('pool.dead')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {verdicts && verdicts.length > 0 && (
        <div className="w3-panel">
          <div className="w3-panel-title">{t('pool.verdicts')}</div>
          {verdicts.map((v) => (
            <div key={v.id} className="w3-row" data-testid={`pool-verdict-${v.id}`}>
              <span className="w3-badge w3-badge--neutral">{v.action}</span>
              <span className="w3-muted">{v.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
