import { useEffect, useState } from 'react';
import { Sprout } from 'lucide-react';

import { createLiveEvolutionBackend } from './mockBackend';
import type {
  Convergence,
  EvolutionBackend,
  EvolutionProposal,
  EvolutionVariant as EvolutionVariantDto,
  FixturesStatus,
  IncubationState,
  KnowledgeCandidate,
  SignalBucket,
  SignalType,
  TimelineNode,
} from './backend';
import { SIGNAL_LABEL } from './backend';
import { IncubationPanel } from './IncubationPanel';
import { ProposalCard } from './ProposalCard';
import { EvolutionTimeline } from './EvolutionTimeline';
import { KnowledgeReview } from './KnowledgeReview';
import { EvolutionVariant } from './EvolutionVariant';
import { FixturesBadge } from './FixturesBadge';
import { EmptyState } from '../EmptyState';

/** 演化视图（独立页）：孵化 + 提案分级 + 时间线 + L3 知识闸门 + evolution_factory 独立渲染。 */
export function EvolutionView({ backend = createLiveEvolutionBackend() }: { backend?: EvolutionBackend }) {
  const [incubation, setIncubation] = useState<IncubationState | null>(null);
  const [proposals, setProposals] = useState<EvolutionProposal[] | null>(null);
  const [timeline, setTimeline] = useState<TimelineNode[] | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeCandidate[] | null>(null);
  const [variants, setVariants] = useState<EvolutionVariantDto[] | null>(null);
  const [fixtures, setFixtures] = useState<FixturesStatus | null>(null);
  const [convergence, setConvergence] = useState<Record<string, Convergence | null>>({});
  const [signal, setSignal] = useState<SignalBucket | null>(null);

  async function load() {
    const [inc, props, tl, know, vars, fix] = await Promise.all([
      backend.fetchIncubation(),
      backend.fetchProposals(),
      backend.fetchTimeline(),
      backend.fetchKnowledgeCandidates(),
      backend.fetchVariants(),
      backend.fetchFixtures(),
    ]);
    setIncubation(inc);
    setProposals(props);
    setTimeline(tl);
    setKnowledge(know);
    setVariants(vars);
    setFixtures(fix);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  async function openSignal(type: SignalType) {
    const bucket = incubation?.signals.find((s) => s.type === type) ?? null;
    setSignal(bucket);
  }

  async function refreshConvergence(id: string) {
    const c = await backend.fetchConvergence(id);
    setConvergence((prev) => ({ ...prev, [id]: c }));
  }

  const hasData =
    incubation ||
    (proposals && proposals.length) ||
    (timeline && timeline.length) ||
    (variants && variants.length) ||
    (knowledge && knowledge.length);

  if (!hasData) {
    return (
      <div className="w3" data-view="evolution">
        <EmptyState icon={Sprout} text="用得越多，它越懂你的领域" />
      </div>
    );
  }

  return (
    <div className="w3" data-view="evolution">
      <div className="w3-summary-bar" data-testid="evo-summary">
        <span className="w3-metric">
          <strong>演化</strong>
        </span>
        {fixtures && (
          <>
            <span className="w3-sep" />
            <FixturesBadge status={fixtures} />
          </>
        )}
      </div>

      <div className="w3-body w3-stack">
        {incubation && <IncubationPanel state={incubation} onOpenSignal={openSignal} />}

        {proposals && proposals.length > 0 && (
          <div className="w3-panel">
            <div className="w3-panel-title">演化提案</div>
            <div className="w3-stack">
              {proposals.map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  convergence={convergence[p.id] ?? null}
                  onApply={async (id) => {
                    await backend.applyProposal(id);
                    void refreshConvergence(id);
                  }}
                  onRevert={async (id) => {
                    await backend.revertProposal(id);
                  }}
                  onEdit={async (id, text) => {
                    await backend.editProposal(id, text);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {timeline && timeline.length > 0 && (
          <EvolutionTimeline nodes={timeline} onRevert={async (id) => { void backend.revertProposal(id); }} />
        )}

        {knowledge && knowledge.length > 0 && (
          <KnowledgeReview candidates={knowledge} onRelease={async (id, note) => { void backend.releaseKnowledge(id, note); }} />
        )}

        {variants && variants.length > 0 && (
          <div className="w3-panel">
            <div className="w3-panel-title">演化变体（evolution_factory）</div>
            <div className="w3-stack">
              {variants.map((v) => (
                <EvolutionVariant key={v.id} item={v} />
              ))}
            </div>
          </div>
        )}
      </div>

      {signal && (
        <div className="w3-drawer" role="dialog" aria-label="信号详情" data-testid="signal-drawer">
          <div className="w3-drawer-head">
            <strong>
              {SIGNAL_LABEL[signal.type]} · {signal.count}
            </strong>
            <button type="button" className="w3-empty-link" onClick={() => setSignal(null)}>
              关闭
            </button>
          </div>
          <div className="w3-stack">
            {signal.examples.map((ex, i) => (
              <div key={i} className="w3-panel" data-testid="signal-example">
                <div>{ex.event}</div>
                <div className="w3-muted">分类置信度 {Math.round(ex.confidence * 100)}%</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
