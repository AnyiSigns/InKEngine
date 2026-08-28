import { useEffect, useState } from 'react';
import { Boxes, Cpu } from 'lucide-react';

import { EmptyState } from '../../EmptyState';
import type { ArchitectureBackend, GovernanceVerdict, PoolGovernance, PoolNode } from '../backend';

/** 结点池 tab：顶部摘要条 + 结点行 + 最近治理裁决。未接线→降级空态。 */
export function PoolTab({ backend }: { backend: ArchitectureBackend }) {
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

  if (data === null) return <div className="w3-muted" data-testid="pool-loading">加载结点池…</div>;

  const { governance, nodes, verdicts } = data;
  if (!governance && !nodes) {
    return <EmptyState icon={Cpu} text="治理数据暂不可用" actionLabel="接线后可用" onAction={() => undefined} />;
  }

  return (
    <div className="w3-stack">
      <div className="w3-summary-bar" data-testid="pool-summary">
        <span className="w3-metric">
          <Boxes size={14} strokeWidth={1.5} />
          <strong data-testid="pool-capacity">
            {governance ? `${governance.used}/${governance.total}` : '—'}
          </strong>
          <span>· {governance?.domain ?? '域'}</span>
        </span>
        <span className="w3-sep" />
        <span className="w3-metric">
          <strong data-testid="pool-budget">
            {governance ? `${governance.weeklyUsed}/${governance.weeklyTotal}` : '—'}
          </strong>
          <span>· {governance?.weeklyPeriod ?? '周'}</span>
        </span>
      </div>

      {nodes && nodes.length > 0 && (
        <div className="w3-panel">
          <div className="w3-panel-title">结点</div>
          {nodes.map((n) => (
            <div key={n.name} className="w3-row-item" data-testid={`pool-node-${n.name}`} data-dead={n.dead}>
              <div className="w3-grow">
                <div className="w3-truncate">{n.name}</div>
                <div className="w3-muted">
                  {n.safetyTier} · {n.version} · 使用 {n.usageCount}
                </div>
              </div>
              {n.dead && (
                <span className="w3-badge w3-badge--warn" data-testid="pool-dead">
                  死亡
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {verdicts && verdicts.length > 0 && (
        <div className="w3-panel">
          <div className="w3-panel-title">最近治理裁决</div>
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
