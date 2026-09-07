/**
 * edge_evidence 命令面（list）——边证据存储只读窗口。
 *
 * 数据源 = runtime.edge_evidence_store（引擎边证据 store；records 通道
 * 持久化，行 = EdgeEvidence 证据计数）。host 只做枚举窗口投影：按域
 * （domain）/源类型（source）过滤 + limit 截断；评分/档位属引擎 tier
 * 语义（宿主不复制），行按引擎持久化字段原样透传。无 store = 结构化
 * 空态（edges 空，不报错）。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** 边证据行（引擎 EdgeEvidence 字段结构投影）。 */
export interface EdgeEvidenceView {
  src_type: string;
  dst_type: string;
  src_contract_version: string;
  dst_contract_version: string;
  context_domain: string;
  success_count: number;
  fail_count: number;
  avg_cost: number;
  policy: boolean;
  origin: string;
  last_used_at: number | null;
  created_at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 窗口参数（limit 缺省 200；>0 正整数，钳到 1000）。 */
function parseWindowParams(raw: unknown): {
  domain: string | null;
  source: string | null;
  limit: number;
} {
  const params = raw as { domain?: unknown; source?: unknown; limit?: unknown } | null;
  let domain: string | null = null;
  if (params !== null && params.domain !== undefined && params.domain !== null) {
    if (typeof params.domain !== 'string' || params.domain === '') {
      throw new BridgeError('edge_evidence.list domain 须为非空字符串', 'invalid_params');
    }
    domain = params.domain;
  }
  let source: string | null = null;
  if (params !== null && params.source !== undefined && params.source !== null) {
    if (typeof params.source !== 'string' || params.source === '') {
      throw new BridgeError('edge_evidence.list source 须为非空字符串', 'invalid_params');
    }
    source = params.source;
  }
  let limit = 200;
  if (params !== null && params.limit !== undefined && params.limit !== null) {
    const value = Number(params.limit);
    if (!Number.isInteger(value) || value <= 0) {
      throw new BridgeError('edge_evidence.list limit 须为正整数', 'invalid_params');
    }
    limit = Math.min(value, 1000);
  }
  return { domain, source, limit };
}

/** 引擎证据行 → 只读投影（键字段 + 计数原样透传）。 */
function toEdgeView(raw: unknown): EdgeEvidenceView {
  const row = isRecord(raw) ? raw : {};
  const keyRaw = row['key'];
  const key = isRecord(keyRaw) ? keyRaw : row;
  return {
    src_type: String(key['src_type'] ?? ''),
    dst_type: String(key['dst_type'] ?? ''),
    src_contract_version: String(key['src_contract_version'] ?? ''),
    dst_contract_version: String(key['dst_contract_version'] ?? ''),
    context_domain: String(key['context_domain'] ?? 'default'),
    success_count: Number(row['success_count'] ?? 0),
    fail_count: Number(row['fail_count'] ?? 0),
    avg_cost: Number(row['avg_cost'] ?? 0),
    policy: row['policy'] === true,
    origin: String(row['origin'] ?? 'runtime'),
    last_used_at: row['last_used_at'] === undefined || row['last_used_at'] === null
      ? null
      : Number(row['last_used_at']),
    created_at: Number(row['created_at'] ?? 0),
  };
}

/** edge_evidence 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const EDGE_EVIDENCE_COMMANDS = [
  'edge_evidence.list',
] as const;

export type EdgeEvidenceCommand = (typeof EDGE_EVIDENCE_COMMANDS)[number];

export function buildEdgeEvidenceCommands(deps: HostBridgeDeps): Readonly<Record<EdgeEvidenceCommand, BridgeHandler>> {
  /** edge_evidence.list：边证据条目窗口（domain/source 过滤 + limit）。 */
  const list: BridgeHandler = async (raw): Promise<Record<string, unknown>> => {
    const store = deps.runtime.edge_evidence_store;
    if (store === null) {
      return { available: false, edges: [] };
    }
    const { domain, source, limit } = parseWindowParams(raw);
    const rows = await store.list_edges(domain).catch(() => []);
    const sourceFilter = (row: unknown): boolean => {
      const keyRaw = isRecord(row) ? row['key'] : null;
      const key = isRecord(keyRaw) ? keyRaw : isRecord(row) ? row : null;
      return key !== null && key['src_type'] === source;
    };
    const filtered = source === null ? rows : rows.filter(sourceFilter);
    return {
      available: true,
      domain,
      edges: filtered.slice(0, limit).map((row) => toEdgeView(row)),
    };
  };

  return { 'edge_evidence.list': list };
}
