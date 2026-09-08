import { useEffect, useState } from 'react';
import { Boxes, Cpu } from 'lucide-react';

import { EmptyState } from '@app/views/EmptyState';
import type { ArchitectureBackend, PoolSnapshotData } from '@app/views/architecture/backend';
import { useT } from '@/i18n/useT';

/** 结点池 tab：pool.snapshot 计数 + 最近判定 + 登记窗口 + 评估入口（只登记）。 */
export function PoolTab({ backend }: { backend: ArchitectureBackend }) {
  const { t } = useT();
  const [data, setData] = useState<PoolSnapshotData | null>(null);
  const [candidate, setCandidate] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [evaluation, setEvaluation] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const d = await backend.fetchPool();
    setData(d);
  };

  useEffect(() => {
    void load();
  }, [backend]);

  const runEvaluate = async (): Promise<void> => {
    if (!candidate.trim()) return;
    setEvaluating(true);
    setEvaluation(null);
    const verdict = await backend.evaluateProposal(candidate);
    setEvaluating(false);
    if (verdict === null) {
      setEvaluation('评估不可用（引擎未装配或 node_id 非法）');
      return;
    }
    setEvaluation(`判定：${JSON.stringify(verdict)}`);
    void load();
  };

  if (data === null) return <div className="w3-muted" data-testid="pool-loading">{t('edge.loading')}</div>;

  if (data.available === false || (data.counts.evaluations === 0 && data.rows.length === 0)) {
    return <EmptyState icon={Cpu} text={t('pool.unavailable')} actionLabel={t('pool.connect_hint')} onAction={() => undefined} />;
  }

  const { counts, last_round, rows } = data;

  return (
    <div className="w3-stack">
      <div className="w3-summary-bar" data-testid="pool-summary">
        <span className="w3-metric">
          <Boxes size={14} strokeWidth={1.5} />
          <strong data-testid="pool-capacity">{counts.pool_count}</strong>
          <span>· 池内结点</span>
        </span>
        <span className="w3-sep" />
        <span className="w3-metric">
          <strong data-testid="pool-budget">
            {counts.weekly_budget_used}
            {counts.weekly_budget_remaining !== null ? `/${counts.weekly_budget_remaining} 余量` : ''}
          </strong>
          <span>· 周预算</span>
        </span>
        <span className="w3-sep" />
        <span className="w3-metric">
          <strong data-testid="pool-dead-count">{counts.dead_node_candidates}</strong>
          <span>· 死结点候选</span>
        </span>
        <span className="w3-sep" />
        <span className="w3-metric">
          <strong data-testid="pool-merges">{counts.near_duplicate_merges}</strong>
          <span>· 近重复合并</span>
        </span>
      </div>

      {Object.keys(counts.verdict_counts).length > 0 && (
        <div className="w3-panel">
          <div className="w3-panel-title">判定计数</div>
          {Object.entries(counts.verdict_counts).map(([verdict, n]) => (
            <div key={verdict} className="w3-row" data-testid={`pool-verdict-${verdict}`}>
              <span className="w3-badge w3-badge--neutral">{verdict}</span>
              <span className="w3-muted">{n} 次</span>
            </div>
          ))}
        </div>
      )}

      {last_round && (
        <div className="w3-panel">
          <div className="w3-panel-title">最近判定</div>
          <div className="w3-row" data-testid="pool-last-round">
            <span className="w3-grow">{last_round.node_id ?? '—'}</span>
            <span className="w3-badge w3-badge--neutral">{last_round.verdict ?? '—'}</span>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="w3-panel">
          <div className="w3-panel-title">治理登记窗口（最多 50 条）</div>
          {rows.map((r, i) => (
            <div key={`${r.node_id}-${i}`} className="w3-row-item" data-testid={`pool-row-${r.node_id}-${i}`}>
              <div className="w3-grow">
                <div className="w3-truncate">{r.node_id}</div>
                {r.reasons.length > 0 && <div className="w3-muted">{r.reasons.join('；')}</div>}
              </div>
              <span className="w3-badge w3-badge--neutral">{r.verdict}</span>
            </div>
          ))}
        </div>
      )}

      <div className="w3-panel">
        <div className="w3-panel-title">评估（只登记，不越权执行）</div>
        <div className="w3-row" style={{ gap: 8 }}>
          <input
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
            placeholder="候选 node_id"
            className="ink-input w-64"
            data-testid="pool-candidate-input"
          />
          <button
            type="button"
            disabled={evaluating}
            onClick={() => void runEvaluate()}
            data-testid="pool-evaluate"
            className="rounded-md bg-[var(--ink-accent)] px-3 py-1.5 text-[10px] font-medium text-[var(--ink-text-base)] hover:opacity-90 cursor-pointer disabled:opacity-50"
          >
            {evaluating ? '评估中…' : '评估'}
          </button>
        </div>
        {evaluation && <div className="w3-muted" data-testid="pool-evaluation">{evaluation}</div>}
      </div>
    </div>
  );
}
