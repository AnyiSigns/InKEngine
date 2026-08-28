import { useState } from 'react';
import { GitCommitVertical, GitFork } from 'lucide-react';

import type { TimelineNode } from './backend';

/** 演化时间线（纵向）：补丁链节点实心/空心 + 版本 + 分叉点并排对照。点节点 → 侧浮抽屉（diff + 回退）。 */
export function EvolutionTimeline({
  nodes,
  onRevert,
}: {
  nodes: TimelineNode[];
  onRevert: (id: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = nodes.find((n) => n.id === openId) ?? null;

  return (
    <div className="w3-stack">
      <div className="w3-panel">
        <div className="w3-panel-title">补丁链时间线</div>
        <div className="w3-timeline" data-testid="timeline">
          {nodes.map((n) => (
            <div
              key={n.id}
              className={`w3-tl-node ${n.solid ? 'w3-tl-node--solid' : ''} ${n.fork ? 'w3-tl-node--branch' : ''}`}
              data-testid={`tl-node-${n.id}`}
              data-solid={n.solid}
              data-fork={n.fork ? 'true' : 'false'}
              onClick={() => setOpenId(n.id)}
            >
              <div className="w3-row">
                {n.fork && <GitFork size={14} strokeWidth={1.5} />}
                <GitCommitVertical size={14} strokeWidth={1.5} />
                <span className="w3-grow">{n.version}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {open && (
        <div className="w3-drawer" role="dialog" aria-label="补丁节点详情" data-testid="tl-drawer">
          <div className="w3-drawer-head">
            <strong>{open.version}</strong>
            <button type="button" className="w3-empty-link" onClick={() => setOpenId(null)}>
              关闭
            </button>
          </div>
          {open.diff && (
            <div className="w3-diff" data-testid="tl-diff">
              {open.diff.map((l, i) => (
                <div key={i} className={`w3-diff-line w3-diff-${l.op}`} data-op={l.op}>
                  {l.text}
                </div>
              ))}
            </div>
          )}
          <div className="w3-row" style={{ marginTop: 12 }}>
            <button type="button" className="w3-empty-link" data-testid="tl-revert" onClick={() => onRevert(open.id)}>
              回退到此处（patch_reverted）
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
