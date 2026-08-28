import type { WhyAuditData, WhyEdge } from './backend';

function rate(evidence: WhyEdge): string {
  const s = evidence.success_count ?? 0;
  const f = evidence.fail_count ?? 0;
  const total = s + f;
  if (total === 0) return '—';
  return `${((s / total) * 100).toFixed(0)}%`;
}

export function WhyPanel({ data }: { data?: WhyAuditData | null }) {
  const audit: WhyAuditData = data ?? {};
  const candidates = audit.candidates ?? [];
  const reasons = audit.reason_chain ?? [];
  const edges = audit.edge_evidence ?? [];

  if (candidates.length === 0 && reasons.length === 0 && edges.length === 0) {
    return (
      <div data-ui="why_panel" className="p-3 text-[12px] text-[var(--ink-text-muted)]">
        暂无「为什么」留痕数据
      </div>
    );
  }

  return (
    <div data-ui="why_panel" className="flex flex-col gap-3 p-3 text-[12px]">
      {reasons.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="font-medium text-[var(--ink-text-base)]">决策点理由链</h4>
          <ul className="flex flex-col gap-1">
            {reasons.map((r, i) => (
              <li
                key={`r-${i}`}
                data-kind={r.type ?? 'unknown'}
                className="rounded border border-[var(--ink-border)] px-2 py-1"
              >
                <span className="font-medium">[{r.type ?? 'unknown'}]</span>
                {r.reason ? <span className="ml-1">{r.reason}</span> : null}
                {r.action ? (
                  <span className="ml-1 text-[var(--ink-text-muted)]">→ 动作: {r.action}</span>
                ) : null}
                {r.review_tier ? (
                  <span className="ml-1 text-[var(--ink-text-muted)]">· {r.review_tier}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {candidates.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="font-medium text-[var(--ink-text-base)]">候选卡（链路展开）</h4>
          {candidates.map((c, i) => (
            <details key={`c-${i}`} className="rounded border border-[var(--ink-border)] px-2 py-1">
              <summary className="cursor-pointer">
                {c.candidate_id || '(未选)'} · {c.domain ?? 'default'}
              </summary>
              <div className="mt-1 text-[var(--ink-text-muted)]">
                链路: {(c.chain ?? []).join(' → ') || '(无)'}
              </div>
            </details>
          ))}
        </section>
      ) : null}

      {edges.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="font-medium text-[var(--ink-text-base)]">边证据归因</h4>
          <table className="w-full text-left">
            <thead>
              <tr className="text-[var(--ink-text-muted)]">
                <th className="pr-2">边</th>
                <th className="pr-2">成功/失败</th>
                <th className="pr-2">成功率</th>
                <th>策略档</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((e, i) => (
                <tr key={`e-${i}`}>
                  <td className="pr-2">
                    {e.src_type}→{e.dst_type}
                  </td>
                  <td className="pr-2">
                    {e.success_count ?? 0}/{e.fail_count ?? 0}
                  </td>
                  <td className="pr-2">{rate(e)}</td>
                  <td>{e.policy ? '是' : '否'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
