import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';

import type {
  LedgerSummary,
  RoundLedgerEntry,
  SourceBackend,
  SourceEntry,
  SourceTabId,
} from './backend';

/** 生产后端：缺口 op 返回 null（降级「暂无来源数据」）。 */
export function createLiveSourceBackend(adapter: BackendAdapter = createBackend()): SourceBackend {
  void adapter;
  return {
    async fetchLedgerSummary() {
      return null;
    },
    async fetchSources() {
      return null;
    },
    async fetchLedgerRound() {
      return null;
    },
  };
}

/** 测试后端：注入夹具。 */
export function createMockSourceBackend(fixtures: {
  ledger?: LedgerSummary | null;
  sources?: Partial<Record<SourceTabId, SourceEntry[] | null>>;
  rounds?: Record<string, RoundLedgerEntry | null>;
}): SourceBackend {
  return {
    async fetchLedgerSummary() {
      return fixtures.ledger ?? null;
    },
    async fetchSources(tab: SourceTabId) {
      return fixtures.sources?.[tab] ?? null;
    },
    async fetchLedgerRound(roundId: string) {
      return fixtures.rounds?.[roundId] ?? null;
    },
  };
}
