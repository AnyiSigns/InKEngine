/**
 * 能力设置存储（host 本地持久化；capability.json）。
 *
 * 能力记录承载推演档位（simulation_tier）等产品设置与自动审批预授权字段。
 * TS host 侧该域为配置面（记录可持久化、读档回显、白名单校验），引擎对
 * 各字段的消费按各自域装配点接入（推演档位供后续 route/assembly 迁移消费；
 * auto_approve_* 供审批策略接线）。
 *
 * 语义对齐壳侧能力命令：记录是「整体存储」——get 只读 + 缺省字段注入，
 * put 先读既有记录再并入（单字段写不覆盖其它字段），字段白名单校验失败
 * 不落盘。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 推演档位合法值（白名单；非法值拒绝落盘）。 */
export const SIMULATION_TIERS = ['off', 'light', 'full'] as const;
export type SimulationTier = (typeof SIMULATION_TIERS)[number];

/** 能力记录（除下述已具名字段外的键原样透传保留）。 */
export interface CapabilityRecord {
  simulation_tier?: SimulationTier;
  max_tool_rounds?: number;
  auto_approve_tools: string[];
  auto_approve_all_review: boolean;
  tier_overrides: Record<string, string>;
  [key: string]: unknown;
}

/** 缺省能力记录（auto 字段出厂空集：不勾选即不预授权，最保守）。 */
export function defaultCapabilityRecord(): CapabilityRecord {
  return {
    auto_approve_tools: [],
    auto_approve_all_review: false,
    tier_overrides: {},
  };
}

export interface CapabilityStore {
  /** 读取记录（无记录 = 缺省；读档时不落盘缺省字段）。 */
  get(): CapabilityRecord;
  /** 合并写入（单字段语义：先读既有记录再并入；返回合并后记录）。 */
  put(patch: Record<string, unknown>): CapabilityRecord;
}

export class CapabilityError extends Error {
  readonly code: string;
  constructor(message: string, code = 'capability_error') {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRecord(raw: unknown): CapabilityRecord {
  const data = isRecord(raw) ? raw : {};
  const out: CapabilityRecord = defaultCapabilityRecord();
  if (
    typeof data['simulation_tier'] === 'string'
    && (SIMULATION_TIERS as readonly string[]).includes(data['simulation_tier'])
  ) {
    out.simulation_tier = data['simulation_tier'] as SimulationTier;
  }
  if (typeof data['max_tool_rounds'] === 'number') {
    out.max_tool_rounds = data['max_tool_rounds'];
  }
  if (Array.isArray(data['auto_approve_tools'])) {
    out.auto_approve_tools = data['auto_approve_tools'].filter(
      (entry): entry is string => typeof entry === 'string',
    );
  }
  if (typeof data['auto_approve_all_review'] === 'boolean') {
    out.auto_approve_all_review = data['auto_approve_all_review'];
  }
  if (isRecord(data['tier_overrides'])) {
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(data['tier_overrides'])) {
      if (typeof value === 'string') overrides[key] = value;
    }
    out.tier_overrides = overrides;
  }
  for (const [key, value] of Object.entries(data)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

export function createCapabilityStore(dataDir: string): CapabilityStore {
  mkdirSync(dataDir, { recursive: true });
  const file = resolve(dataDir, 'capability.json');

  function read(): CapabilityRecord {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return parseRecord(raw);
    } catch {
      return defaultCapabilityRecord();
    }
  }

  function persist(record: CapabilityRecord): CapabilityRecord {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, file);
    return record;
  }

  let cached = read();

  return {
    get: (): CapabilityRecord => cached,
    put: (patch: Record<string, unknown>): CapabilityRecord => {
      const merged: Record<string, unknown> = { ...cached };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        merged[key] = value;
      }
      const record = parseRecord(merged);
      cached = persist(record);
      return cached;
    },
  };
}
