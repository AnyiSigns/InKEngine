import type { Convergence } from './backend';

/** 评审收敛强化：收敛轮次徽标「轮次 · 2/2」+ 逐维度分（达阈墨绿/未达警示）+ failing 列表 + Beam 对比行。 */
export function ConvergenceCard({ convergence }: { convergence: Convergence }) {
  return (
    <div className="w3-panel" data-testid="convergence" style={{ marginTop: 8 }}>
      <div className="w3-row">
        <span className="w3-badge w3-badge--neutral" data-testid="convergence-rounds">
          轮次 · {convergence.rounds.current}/{convergence.rounds.total}
        </span>
      </div>
      <div className="w3-stack" style={{ marginTop: 8 }}>
        {convergence.dimensions.map((d) => (
          <div key={d.name} className="w3-row" data-testid="convergence-dim" data-passed={d.passed}>
            <span className="w3-grow">{d.name}</span>
            <span className={`w3-badge ${d.passed ? 'w3-badge--ok' : 'w3-badge--warn'}`}>
              {d.score} / 阈 {d.threshold}
            </span>
          </div>
        ))}
      </div>
      {convergence.failing.length > 0 && (
        <div className="w3-error-line" data-testid="convergence-failing" style={{ marginTop: 8 }}>
          未达标维度：{convergence.failing.join('、')}
        </div>
      )}
      <div className="w3-row" style={{ marginTop: 8 }}>
        <span className="w3-muted w3-grow">Beam 对比</span>
        <span className="w3-badge w3-badge--neutral" data-testid="convergence-beam">
          A {convergence.beam.candidateA} · B {convergence.beam.candidateB}
        </span>
      </div>
    </div>
  );
}
