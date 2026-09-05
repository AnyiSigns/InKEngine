import { useEffect, useState } from 'react';
import { ChevronRight, GitMerge, TrendingDown } from 'lucide-react';

import { EmptyState } from '../../EmptyState';
import type { ArchitectureBackend, AssemblyResult, EdgeEvidence, TrustTier } from '../backend';
import { Button } from '@/shared/ui/Button';
import { useT } from '@/i18n/useT';

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

function trustLabel(t: (k: string) => string, tier: TrustTier): string {
  switch (tier) {
    case 'observe': return t('edge.trust.observe');
    case 'normal': return t('edge.trust.normal');
    case 'promoted': return t('edge.trust.promoted');
  }
}

/** 边证据 tab：信任档分节（≠评审分，R2）+ 评分下钻 + 晋升留痕 + 人工降级。
 *  标准模式=空态提示（R13：不显「当前模式」整词）；组装模式=最近组装回合结果。 */
export function EdgeEvidenceTab({
  backend,
  assemblyResult,
  onOpenAssembly,
}: {
  backend: ArchitectureBackend;
  assemblyResult: AssemblyResult | null;
  onOpenAssembly?: () => void;
}) {
  const { t } = useT();
  const [edges, setEdges] = useState<EdgeEvidence[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void backend.fetchEdgeEvidence().then((e) => {
      if (!alive) return;
      setEdges(e);
    });
    return () => {
      alive = false;
    };
  }, [backend]);

  const open = edges?.find((e) => e.id === openId) ?? null;

  return (
    <div className="w3-stack" data-tab="edge">
      {!assemblyResult && (
        <div className="w3-receipt" data-testid="edge-assembly-empty">
          <span>{t('edge.assembly_disabled')}</span>
          {onOpenAssembly && (
            <button type="button" className="w3-empty-link" data-testid="edge-open-assembly" onClick={onOpenAssembly} style={{ marginLeft: 12 }}>
              {t('edge.open_assembly')}
            </button>
          )}
        </div>
      )}

      {assemblyResult && (
        <div className="w3-panel" data-testid="edge-assembly-result">
          <div className="w3-panel-title">
            <GitMerge size={14} strokeWidth={1.5} /> {interpolate(t('edge.assembly_result'), { round: assemblyResult.roundId })}
          </div>
          <div className="w3-muted">{t('edge.candidates')}</div>
          {assemblyResult.candidates.map((c, i) => (
            <div key={i} className="w3-row" data-testid="edge-candidate">
              <span className="w3-truncate">{c.path}</span>
              <span className="w3-badge w3-badge--neutral">{interpolate(t('edge.score'), { s: c.score })}</span>
            </div>
          ))}
          <div className="w3-row" style={{ marginTop: 8 }}>
            <span className="w3-muted">{t('edge.junction')}</span>
            <span className="w3-badge w3-badge--ok">{assemblyResult.junction.verdict} · {assemblyResult.junction.score}</span>
          </div>
        </div>
      )}

      <div className="w3-panel">
        <div className="w3-panel-title">{t('edge.trust_tier_header')}</div>
        {edges === null && <div className="w3-muted" data-testid="edge-loading">{t('edge.loading')}</div>}
        {edges !== null && edges.length === 0 && (
          <EmptyState icon={GitMerge} text={t('edge.empty')} />
        )}
        {edges?.map((e) => (
          <div key={e.id} className="w3-row-item" data-testid={`edge-row-${e.id}`} data-trust={e.trustTier} onClick={() => setOpenId(e.id)}>
            <div className="w3-grow">
              <div className="w3-truncate">
                {e.from} → {e.to}
              </div>
              <div className="w3-muted">{interpolate(t('edge.promotion_prior'), { t: e.promotion ? t('edge.has_trace') : t('edge.no_trace') })}</div>
            </div>
            <span className={`w3-badge w3-trust--${e.trustTier}`} data-testid="edge-trust">
              {trustLabel(t, e.trustTier)}
            </span>
            <ChevronRight size={14} strokeWidth={1.5} />
          </div>
        ))}
      </div>

      {open && (
        <div className="w3-drawer" role="dialog" aria-label={t('edge.score_header')} data-testid="edge-drawer">
          <div className="w3-drawer-head">
            <strong>{open.from} → {open.to}</strong>
            <button type="button" className="w3-empty-link" onClick={() => setOpenId(null)}>
              {t('edge.close')}
            </button>
          </div>
          <div className="w3-muted">{t('edge.score_header')}</div>
          <div className="w3-row" style={{ marginTop: 8 }}>
            <span className="w3-grow">{t('edge.phat')}</span>
            <span data-testid="edge-phat">{open.score.phat}</span>
          </div>
          <div className="w3-row">
            <span className="w3-grow">{t('edge.weight')}</span>
            <span>{open.score.w}</span>
          </div>
          <div className="w3-row">
            <span className="w3-grow">{t('edge.dt')}</span>
            <span>{open.score.dt}</span>
          </div>
          <div className="w3-row">
            <span className="w3-grow">{t('edge.tau')}</span>
            <span>{open.score.tau}</span>
          </div>
          {open.promotion && (
            <div className="w3-row" style={{ marginTop: 8 }}>
              <span className="w3-badge w3-badge--ok">{t('edge.promotion_trace')}</span>
              <span className="w3-muted">{open.promotion.note}</span>
            </div>
          )}
          <div className="w3-row" style={{ marginTop: 12 }}>
            <Button variant="secondary" onClick={() => void backend.downgradeEdge(open.id)} data-testid="edge-downgrade">
              <TrendingDown size={14} strokeWidth={1.5} /> {t('edge.downgrade')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
