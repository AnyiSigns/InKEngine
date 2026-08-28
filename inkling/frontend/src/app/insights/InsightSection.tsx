import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { createInsightOps, type InsightOps, type WhyAuditData, type SovereigntySnapshot, type SuggestionScan } from './backend';
import { WhyPanel } from './WhyPanel';
import { SovereigntyView } from './SovereigntyView';
import { SuggestionBar } from './SuggestionBar';

export function InsightSection() {
  const opsRef = useRef<InsightOps>(createInsightOps());
  const [why, setWhy] = useState<WhyAuditData | null>(null);
  const [sovereignty, setSovereignty] = useState<SovereigntySnapshot | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionScan | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const ops = opsRef.current;
      const [w, s, sg] = await Promise.all([
        ops.whyAudit(),
        ops.sovereigntySnapshot(),
        ops.suggestionScan(),
      ]);
      setWhy(w);
      setSovereignty(s);
      setSuggestions(sg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div data-ui="insight_section" className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">洞察</h3>
        <Button size="xs" variant="ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={12} strokeWidth={1.6} />
          刷新
        </Button>
      </div>

      <section className="flex flex-col gap-1">
        <h4 className="text-[11px] font-medium text-[var(--ink-text-muted)]">情境建议</h4>
        <SuggestionBar data={suggestions} />
      </section>

      <section className="flex flex-col gap-1">
        <h4 className="text-[11px] font-medium text-[var(--ink-text-muted)]">数据主权</h4>
        <SovereigntyView data={sovereignty} />
      </section>

      <section className="flex flex-col gap-1">
        <h4 className="text-[11px] font-medium text-[var(--ink-text-muted)]">决策审计</h4>
        <WhyPanel data={why} />
      </section>
    </div>
  );
}
