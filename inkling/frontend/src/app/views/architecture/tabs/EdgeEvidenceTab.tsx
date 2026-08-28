import { useEffect, useState } from 'react';
import { ChevronRight, GitMerge, TrendingDown } from 'lucide-react';

import { EmptyState } from '../../EmptyState';
import type { ArchitectureBackend, AssemblyResult, EdgeEvidence, TrustTier } from '../backend';
import { Button } from '@/shared/ui/Button';

const TRUST_LABEL: Record<TrustTier, string> = {
  observe: '观察',
  normal: '常规',
  promoted: '转正',
};

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
          <span>组装模式未开启 · 边证据仅统计展示</span>
          {onOpenAssembly && (
            <button type="button" className="w3-empty-link" data-testid="edge-open-assembly" onClick={onOpenAssembly} style={{ marginLeft: 12 }}>
              去输入行开启组装
            </button>
          )}
        </div>
      )}

      {assemblyResult && (
        <div className="w3-panel" data-testid="edge-assembly-result">
          <div className="w3-panel-title">
            <GitMerge size={14} strokeWidth={1.5} /> 最近组装回合结果（{assemblyResult.roundId}）
          </div>
          <div className="w3-muted">候选路径</div>
          {assemblyResult.candidates.map((c, i) => (
            <div key={i} className="w3-row" data-testid="edge-candidate">
              <span className="w3-truncate">{c.path}</span>
              <span className="w3-badge w3-badge--neutral">评分 {c.score}</span>
            </div>
          ))}
          <div className="w3-row" style={{ marginTop: 8 }}>
            <span className="w3-muted">汇流</span>
            <span className="w3-badge w3-badge--ok">{assemblyResult.junction.verdict} · {assemblyResult.junction.score}</span>
          </div>
        </div>
      )}

      <div className="w3-panel">
        <div className="w3-panel-title">信任档（边可靠性，自动晋级）</div>
        {edges === null && <div className="w3-muted" data-testid="edge-loading">加载边证据…</div>}
        {edges !== null && edges.length === 0 && (
          <EmptyState icon={GitMerge} text="暂无边证据" />
        )}
        {edges?.map((e) => (
          <div key={e.id} className="w3-row-item" data-testid={`edge-row-${e.id}`} data-trust={e.trustTier} onClick={() => setOpenId(e.id)}>
            <div className="w3-grow">
              <div className="w3-truncate">
                {e.from} → {e.to}
              </div>
              <div className="w3-muted">推荐先验晋升：{e.promotion ? '有留痕' : '无'}</div>
            </div>
            <span className={`w3-badge w3-trust--${e.trustTier}`} data-testid="edge-trust">
              {TRUST_LABEL[e.trustTier]}
            </span>
            <ChevronRight size={14} strokeWidth={1.5} />
          </div>
        ))}
      </div>

      {open && (
        <div className="w3-drawer" role="dialog" aria-label="评分下钻" data-testid="edge-drawer">
          <div className="w3-drawer-head">
            <strong>{open.from} → {open.to}</strong>
            <button type="button" className="w3-empty-link" onClick={() => setOpenId(null)}>
              关闭
            </button>
          </div>
          <div className="w3-muted">评分分量（p̂·w·d(t)·τ，不合成单一「评审分」）</div>
          <div className="w3-row" style={{ marginTop: 8 }}>
            <span className="w3-grow">p̂ 成功率</span>
            <span data-testid="edge-phat">{open.score.phat}</span>
          </div>
          <div className="w3-row">
            <span className="w3-grow">w 权重</span>
            <span>{open.score.w}</span>
          </div>
          <div className="w3-row">
            <span className="w3-grow">d(t) 衰减</span>
            <span>{open.score.dt}</span>
          </div>
          <div className="w3-row">
            <span className="w3-grow">τ 阈值</span>
            <span>{open.score.tau}</span>
          </div>
          {open.promotion && (
            <div className="w3-row" style={{ marginTop: 8 }}>
              <span className="w3-badge w3-badge--ok">晋升留痕</span>
              <span className="w3-muted">{open.promotion.note}</span>
            </div>
          )}
          <div className="w3-row" style={{ marginTop: 12 }}>
            <Button variant="secondary" onClick={() => void backend.downgradeEdge(open.id)} data-testid="edge-downgrade">
              <TrendingDown size={14} strokeWidth={1.5} /> 人工降级
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
