/**
 * 数据主权仪表视图：本地数据资产位置 + 模型挡位 + 访问审计概览。
 *
 * bindValue 取 sovereignty.snapshot 产出：本地存储后端与位置、技能存储
 * 路径、模型挡位声明、访问审计计数与最近若干条。复用 dashboard/设置面板
 * 形态的卡片式布局；纯展示、无副作用，空态不崩。
 */

interface SovereigntySnapshot {
  local_storage?: { backend?: string | null; location?: string };
  skill_store_path?: string | null;
  model_tiers?: string[];
  tier_call_stats_persisted?: boolean;
  audit_total?: number;
  audit_counts?: Record<string, number>;
  recent_audit?: Array<{ type?: string | null; ts?: number }>;
}

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return '—';
  }
}

export function SovereigntyView({ bindValue }: { bindValue?: SovereigntySnapshot | null }) {
  const data: SovereigntySnapshot = bindValue ?? {};
  const tiers = data.model_tiers ?? [];
  const auditCounts = data.audit_counts ?? {};
  const recent = data.recent_audit ?? [];

  return (
    <div data-ui="sovereignty_view" className="flex flex-col gap-3 p-3 text-[12px]">
      <section className="rounded border ink-border p-2">
        <h4 className="font-medium ink-text-base">本地数据资产</h4>
        <div className="ink-text-muted">
          存储后端: {data.local_storage?.backend ?? '未知'}
        </div>
        <div className="ink-text-muted">
          存储位置: {data.local_storage?.location ?? '（内存态/未暴露）'}
        </div>
        <div className="ink-text-muted">
          技能存储: {data.skill_store_path ?? '（内存态/未暴露）'}
        </div>
      </section>

      <section className="rounded border ink-border p-2">
        <h4 className="font-medium ink-text-base">模型挡位</h4>
        {tiers.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {tiers.map((t) => (
              <li key={t} className="rounded ink-border px-2 py-0.5">
                {t}
              </li>
            ))}
          </ul>
        ) : (
          <div className="ink-text-muted">无</div>
        )}
        <div className="ink-text-muted">
          逐回合挡位调用统计是否已持久化:{' '}
          {data.tier_call_stats_persisted ? '是' : '否（仅配置面）'}
        </div>
      </section>

      <section className="rounded border ink-border p-2">
        <h4 className="font-medium ink-text-base">
          访问审计（共 {data.audit_total ?? 0} 条）
        </h4>
        {Object.keys(auditCounts).length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {Object.entries(auditCounts).map(([k, v]) => (
              <li key={k} className="ink-text-muted">
                {k}: {v}
              </li>
            ))}
          </ul>
        ) : (
          <div className="ink-text-muted">暂无审计</div>
        )}
        {recent.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {recent.slice(0, 10).map((a, i) => (
              <li key={`a-${i}`} className="ink-text-muted">
                {a.type ?? 'unknown'} · {fmtTime(a.ts)}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
