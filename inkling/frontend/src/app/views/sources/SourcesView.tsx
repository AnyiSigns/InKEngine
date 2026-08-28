import { useEffect, useState } from 'react';
import { ChevronDown, Database, History } from 'lucide-react';

import { createLiveSourceBackend } from './mockBackend';
import type { LedgerSummary, RoundLedgerEntry, SourceBackend, SourceEntry, SourceTabId } from './backend';
import { SOURCE_TABS } from './backend';
import { EmptyState } from '../EmptyState';

/** 来源视图：六 tab + 账本摘要卡 + 轮次回放抽屉（机器术语豁免层）。 */
export function SourcesView({ backend = createLiveSourceBackend() }: { backend?: SourceBackend }) {
  const [tab, setTab] = useState<SourceTabId>('round_steps');
  const [ledger, setLedger] = useState<LedgerSummary | null>(null);
  const [entries, setEntries] = useState<SourceEntry[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [openRaw, setOpenRaw] = useState<string | null>(null);
  const [replay, setReplay] = useState<RoundLedgerEntry | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([backend.fetchLedgerSummary(), backend.fetchSources(tab)]).then(([l, e]) => {
      if (!alive) return;
      setLedger(l);
      setEntries(e);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [backend, tab]);

  function openReplay(roundId: string) {
    void backend.fetchLedgerRound(roundId).then((r) => r && setReplay(r));
  }

  return (
    <div className="w3" data-view="sources">
      <div className="w3-tabs" role="tablist">
        {SOURCE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`w3-tab ${tab === t.id ? 'w3-tab--active' : ''}`}
            data-testid={`src-tab-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="w3-body w3-stack">
        {ledger && (
          <div className="w3-panel" data-testid="ledger-summary">
            <div className="w3-panel-title">
              <Database size={14} strokeWidth={1.5} /> 账本摘要
            </div>
            <div className="w3-muted">
              本轮事实快照 {ledger.snapshots} 条 · 摘要链 {ledger.chainSegments} 段
            </div>
            <button type="button" className="w3-empty-link" data-testid="ledger-replay" onClick={() => openReplay(`round-${ledger.snapshots}`)}>
              轮次回放
            </button>
          </div>
        )}

        {!loaded && <div className="w3-muted" data-testid="src-loading">加载来源…</div>}
        {loaded && entries === null && (
          <EmptyState icon={History} text="暂无来源数据" />
        )}
        {entries && entries.length === 0 && <EmptyState icon={History} text="暂无来源数据" />}

        {entries?.map((e) => (
          <div key={e.id} className="w3-panel" data-testid={`src-entry-${e.id}`} data-type={e.type}>
            <div className="w3-row">
              <span className="w3-grow">{e.title}</span>
              {e.confidence !== undefined && (
                <span className="w3-badge w3-badge--ok" data-testid="src-confidence">
                  {Math.round(e.confidence * 100)}%
                </span>
              )}
            </div>
            <div className="w3-muted">{e.detail}</div>
            {e.raw && (
              <div className="w3-row" style={{ marginTop: 6 }}>
                <button type="button" className="w3-empty-link" data-testid={`src-raw-${e.id}`} onClick={() => setOpenRaw((p) => (p === e.id ? null : e.id))}>
                  <ChevronDown size={14} strokeWidth={1.5} /> 原始事件
                </button>
              </div>
            )}
            {openRaw === e.id && e.raw && (
              <pre className="w3-diff" data-testid="src-raw-block">
                {JSON.stringify(e.raw, null, 2)}
              </pre>
            )}
          </div>
        ))}

        {replay && (
          <div className="w3-drawer" role="dialog" aria-label="轮次回放" data-testid="replay-drawer">
            <div className="w3-drawer-head">
              <strong>
                <History size={14} strokeWidth={1.5} /> 回合 {replay.roundId}
              </strong>
              <button type="button" className="w3-empty-link" onClick={() => setReplay(null)}>
                关闭
              </button>
            </div>
            <div className="w3-row">
              <span className="w3-grow">摘要</span>
              <span>{replay.summary}</span>
            </div>
            <div className="w3-row">
              <span className="w3-grow">成本</span>
              <span>{replay.cost}</span>
            </div>
            <div className="w3-row">
              <span className="w3-grow">结论</span>
              <span>{replay.conclusion}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
