import type { SovereigntySnapshot } from './backend';

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return '—';
  }
}

export function SovereigntyView({ data }: { data?: SovereigntySnapshot | null }) {
  const snapshot: SovereigntySnapshot = data ?? {};
  const tiers = snapshot.model_tiers ?? [];
  const auditCounts = snapshot.audit_counts ?? {};
  const recent = snapshot.recent_audit ?? [];

  return (
    <div data-ui="sovereignty_view" className="flex flex-col gap-3 p-3 text-[12px]">
      <section className="rounded border border-[var(--ink-border)] p-2">
        <h4 className="font-medium text-[var(--ink-text-base)]">本地数据资产</h4>
        <div className="text-[var(--ink-text-muted)]">
          存储后端: {snapshot.local_storage?.backend ?? '未知'}
        </div>
        <div className="text-[var(--ink-text-muted)]">
          存储位置: {snapshot.local_storage?.location ?? '（内存态/未暴露）'}
        </div>
        <div className="text-[var(--ink-text-muted)]">
          技能存储: {snapshot.skill_store_path ?? '（内存态/未暴露）'}
        </div>
      </section>

      <section className="rounded border border-[var(--ink-border)] p-2">
        <h4 className="font-medium text-[var(--ink-text-base)]">模型挡位</h4>
        {tiers.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {tiers.map((t) => (
              <li key={t} className="rounded border border-[var(--ink-border)] px-2 py-0.5">
                {t}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[var(--ink-text-muted)]">无</div>
        )}
        <div className="text-[var(--ink-text-muted)]">
          逐回合挡位调用统计是否已持久化:{' '}
          {snapshot.tier_call_stats_persisted ? '是' : '否（仅配置面）'}
        </div>
      </section>

      <section className="rounded border border-[var(--ink-border)] p-2">
        <h4 className="font-medium text-[var(--ink-text-base)]">
          访问审计（共 {snapshot.audit_total ?? 0} 条）
        </h4>
        {Object.keys(auditCounts).length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {Object.entries(auditCounts).map(([k, v]) => (
              <li key={k} className="text-[var(--ink-text-muted)]">
                {k}: {v}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[var(--ink-text-muted)]">暂无审计</div>
        )}
        {recent.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {recent.slice(0, 10).map((a, i) => (
              <li key={`a-${i}`} className="text-[var(--ink-text-muted)]">
                {a.type ?? 'unknown'} · {fmtTime(a.ts)}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
