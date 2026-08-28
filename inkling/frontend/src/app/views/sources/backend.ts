export type SourceTabId =
  | 'round_steps'
  | 'memory_recall'
  | 'tuning'
  | 'vetting'
  | 'device_sensed'
  | 'device_control';

export const SOURCE_TABS: Array<{ id: SourceTabId; label: string }> = [
  { id: 'round_steps', label: '回合步骤' },
  { id: 'memory_recall', label: '记忆召回' },
  { id: 'tuning', label: '调参' },
  { id: 'vetting', label: '审查' },
  { id: 'device_sensed', label: '设备感知' },
  { id: 'device_control', label: '设备控制' },
];

export interface SourceEntry {
  id: string;
  type: string;
  title: string;
  detail: string;
  time: number;
  /** 可信度徽标（机器术语豁免层外的可读维度）。 */
  confidence?: number;
  /** 机器术语豁免层：可展开原始事件。 */
  raw?: Record<string, unknown>;
}

export interface LedgerSummary {
  snapshots: number;
  chainSegments: number;
}

export interface RoundLedgerEntry {
  roundId: string;
  summary: string;
  cost: number;
  conclusion: string;
  time: number;
}

export interface SourceBackend {
  fetchLedgerSummary(): Promise<LedgerSummary | null>;
  fetchSources(tab: SourceTabId): Promise<SourceEntry[] | null>;
  fetchLedgerRound(roundId: string): Promise<RoundLedgerEntry | null>;
}
