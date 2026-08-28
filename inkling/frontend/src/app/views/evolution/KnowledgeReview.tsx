import { useState } from 'react';
import { DoorClosed, ShieldCheck, X } from 'lucide-react';

import type { KnowledgeCandidate } from './backend';
import { Button } from '@/shared/ui/Button';

/** 知识 L3 人工评审闸门（演化视图入口）：候选知识 + 维度分 + 确认放行/拒绝 + 可选备注；
 *  未确认不放行；徽标「闸门 · L3」三角门图标（R3）。 */
export function KnowledgeReview({
  candidates,
  onRelease,
}: {
  candidates: KnowledgeCandidate[];
  onRelease: (id: string, note?: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const open = candidates.find((c) => c.id === openId) ?? null;

  if (candidates.length === 0) return null;

  return (
    <div className="w3-stack">
      <div className="w3-panel">
        <div className="w3-panel-title">
          <DoorClosed size={14} strokeWidth={1.5} /> 知识闸门 · L3
        </div>
        {candidates.map((c) => (
          <div key={c.id} className="w3-row-item" data-testid={`knowledge-${c.id}`} data-released={c.released ? 'true' : 'false'} onClick={() => setOpenId(c.id)}>
            <div className="w3-grow w3-truncate">{c.content}</div>
            {c.released ? (
              <span className="w3-badge w3-badge--ok">已放行</span>
            ) : (
              <span className="w3-badge w3-badge--neutral">待审</span>
            )}
          </div>
        ))}
      </div>

      {open && (
        <div className="w3-floater-backdrop" data-testid="knowledge-floater">
          <div className="w3-floater floater--approval" role="dialog" aria-label="知识 L3 评审">
            <div className="w3-drawer-head">
              <strong>
                <DoorClosed size={14} strokeWidth={1.5} /> 闸门 · L3
              </strong>
              <button type="button" className="w3-empty-link" onClick={() => setOpenId(null)}>
                关闭
              </button>
            </div>
            <div className="w3-muted">{open.content}</div>
            <div className="w3-stack" style={{ marginTop: 8 }}>
              {open.dimensions.map((d) => (
                <div key={d.name} className="w3-row" data-testid="knowledge-dim" data-passed={d.passed}>
                  <span className="w3-grow">{d.name}</span>
                  <span className={`w3-badge ${d.passed ? 'w3-badge--ok' : 'w3-badge--warn'}`}>
                    {d.score} / 阈 {d.threshold}
                  </span>
                </div>
              ))}
            </div>
            <textarea
              className="w3-grow"
              data-testid="knowledge-note"
              placeholder="可选备注"
              style={{ marginTop: 8, minHeight: 48 }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="w3-floater-actions">
              <div className="w3-stack-v">
                <Button variant="ghost" onClick={() => setOpenId(null)} data-testid="knowledge-reject">
                  <X size={14} strokeWidth={1.5} /> 拒绝
                </Button>
              </div>
              <Button variant="primary" onClick={() => { onRelease(open.id, note || undefined); setOpenId(null); setNote(''); }} data-testid="knowledge-release" disabled={!open.dimensions.every((d) => d.passed)}>
                <ShieldCheck size={14} strokeWidth={1.5} /> 确认放行
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
