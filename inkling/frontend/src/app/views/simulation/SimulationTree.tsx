import { GitBranch } from 'lucide-react';

import type { BranchGroupKind, SimulationGroup } from './backend';
import { GROUP_LABEL } from './backend';
import { CandidateCard } from './CandidateCard';

/** 推演树渲染器：分支分组（replan/decision/multipath）；spawn 组由会话区呈现（混2 防接错）。 */
export function SimulationTree({
  groups,
  onSwap,
}: {
  groups: SimulationGroup[];
  onSwap: (id: string) => void;
}) {
  const renderable: BranchGroupKind[] = ['replan', 'decision', 'multipath'];
  return (
    <div className="w3-stack" data-testid="sim-tree">
      {groups.map((g) => {
        if (g.kind === 'spawn') {
          return (
            <div key={g.kind} className="w3-muted" data-testid="sim-spawn-note">
              拆解分支在会话区呈现
            </div>
          );
        }
        if (!renderable.includes(g.kind)) return null;
        return (
          <div key={g.kind} className="w3-panel" data-group={g.kind}>
            <div className="w3-panel-title">
              <GitBranch size={14} strokeWidth={1.5} /> {GROUP_LABEL[g.kind]}
            </div>
            {g.candidates.map((c) => (
              <CandidateCard key={c.id} candidate={c} onSwap={onSwap} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
