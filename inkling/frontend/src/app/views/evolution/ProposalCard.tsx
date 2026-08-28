import { useState } from 'react';
import { Check, Pencil, RotateCcw, X } from 'lucide-react';

import type { Convergence, EvolutionProposal } from './backend';
import { Button } from '@/shared/ui/Button';
import { ConvergenceCard } from './ConvergenceCard';

/** 演化提案卡：L0 直过（静默）/ L1 弹卡（diff 预览 + 接受/拒绝/编辑）/ L2 沙箱确认（试跑 + 朱砂徽标）。
 *  徽标带体系前缀「审批 · Lx」（R3）。 */
export function ProposalCard({
  proposal,
  convergence,
  onApply,
  onRevert,
  onEdit,
}: {
  proposal: EvolutionProposal;
  convergence?: Convergence | null;
  onApply: (id: string) => void;
  onRevert: (id: string) => void;
  onEdit: (id: string, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // L0 直过：仅时间线徽标（由父级渲染），卡片内静默不弹卡
  if (proposal.level === 0) {
    return (
      <div className="w3-panel" data-testid={`proposal-${proposal.id}`} data-level="0">
        <div className="w3-row">
          <span className="w3-badge w3-badge--neutral" data-testid="proposal-level">
            审批 · L0
          </span>
          <span className="w3-grow">{proposal.title}</span>
          <span className="w3-muted">直过</span>
        </div>
      </div>
    );
  }

  return (
    <div className="w3-panel" data-testid={`proposal-${proposal.id}`} data-level={proposal.level}>
      <div className="w3-row">
        <span className={`w3-badge ${proposal.level === 2 ? 'w3-badge--approval' : 'w3-badge--neutral'}`} data-testid="proposal-level">
          审批 · L{proposal.level}
        </span>
        <span className="w3-grow">{proposal.title}</span>
        {proposal.applied && (
          <span className="w3-badge w3-badge--ok" data-testid="proposal-applied">
            已应用
          </span>
        )}
        {proposal.reverted && (
          <span className="w3-badge w3-badge--warn" data-testid="proposal-reverted">
            已回退
          </span>
        )}
      </div>

      {proposal.diff && (
        <div className="w3-diff" data-testid="proposal-diff" style={{ marginTop: 8 }}>
          {proposal.diff.map((l, i) => (
            <div key={i} className={`w3-diff-line w3-diff-${l.op}`} data-op={l.op}>
              {l.text}
            </div>
          ))}
        </div>
      )}

      {proposal.level === 2 && proposal.sandboxResult && (
        <div className="w3-receipt" data-testid="proposal-sandbox" style={{ marginTop: 8 }}>
          {proposal.sandboxResult}
        </div>
      )}

      {convergence && <ConvergenceCard convergence={convergence} />}

      <div className="w3-row" style={{ marginTop: 10 }}>
        <Button variant="primary" onClick={() => onApply(proposal.id)} data-testid="proposal-accept">
          <Check size={14} strokeWidth={1.5} /> 接受
        </Button>
        {proposal.level === 1 && (
          <Button variant="ghost" onClick={() => setEditing((v) => !v)} data-testid="proposal-edit">
            <Pencil size={14} strokeWidth={1.5} /> 编辑
          </Button>
        )}
        <Button variant="secondary" onClick={() => onRevert(proposal.id)} data-testid="proposal-reject">
          <X size={14} strokeWidth={1.5} /> 拒绝
        </Button>
        {proposal.applied && (
          <Button variant="ghost" onClick={() => onRevert(proposal.id)} data-testid="proposal-rollback">
            <RotateCcw size={14} strokeWidth={1.5} /> 回退
          </Button>
        )}
      </div>

      {editing && (
        <div className="w3-row" style={{ marginTop: 8 }}>
          <input
            className="w3-grow"
            data-testid="proposal-edit-input"
            value={draft}
            placeholder="编辑提案内容"
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button variant="primary" onClick={() => { onEdit(proposal.id, draft); setEditing(false); }} data-testid="proposal-edit-save">
            保存
          </Button>
        </div>
      )}
    </div>
  );
}
