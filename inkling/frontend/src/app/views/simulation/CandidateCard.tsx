import { useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';

import type { SimulationCandidate } from './backend';
import { Button } from '@/shared/ui/Button';

/** 候选卡：评分/收敛轮/成本/摘要 + 差异折叠。 */
export function CandidateCard({
  candidate,
  onSwap,
}: {
  candidate: SimulationCandidate;
  onSwap: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`w3-candidate ${candidate.selected ? 'w3-candidate--selected' : ''}`} data-testid={`candidate-${candidate.id}`} data-selected={candidate.selected}>
      <div className="w3-row">
        <span className="w3-grow">分支 {candidate.branch} · {candidate.title}</span>
        {candidate.selected && (
          <span className="w3-badge w3-badge--ok" data-testid="candidate-selected">
            已选
          </span>
        )}
      </div>
      <div className="w3-row w3-muted">
        <span>评分 {candidate.score}</span>
        <span>收敛轮 {candidate.rounds}</span>
        <span>成本 {candidate.cost}</span>
      </div>
      <div className="w3-muted" style={{ marginTop: 4 }}>
        {candidate.summary}
      </div>
      {candidate.diff && (
        <div className="w3-row" style={{ marginTop: 6 }}>
          <Button variant="ghost" onClick={() => setOpen((v) => !v)} data-testid="candidate-diff-toggle">
            <ChevronsUpDown size={14} strokeWidth={1.5} /> {open ? '收起差异' : '展开差异'}
          </Button>
        </div>
      )}
      {open && candidate.diff && (
        <pre className="w3-diff" data-testid="candidate-diff" style={{ marginTop: 6 }}>
          {candidate.diff}
        </pre>
      )}
      {!candidate.selected && (
        <div className="w3-row" style={{ marginTop: 6 }}>
          <Button variant="secondary" onClick={() => onSwap(candidate.id)} data-testid={`candidate-swap-${candidate.id}`}>
            换选
          </Button>
        </div>
      )}
    </div>
  );
}
