/**
 * 能力设置存储（host 本地持久化；capability.json）。
 *
 * 能力记录承载自动审批预授权字段（auto_approve_tools 工具级直过名单 /
 * auto_approve_all_review 全量直过）与 max_tool_rounds（agent 工具回合
 * 上限装配位）。推演档位（simulation_tier）语义已移除：不设推演档位，
 * 推演直接开启；历史记录残留的档位键在读取时丢弃（不随 passthrough 回显）。
 *
 * auto_approve_* 供审批策略接线（host.interrupt_policy 构造时并入）；策略
 * 实例为活读面——每次 should_approve 取当前记录，capability.put 后下个请求
 * 即生效。max_tool_rounds 为 host 侧登记装配位（agent 图工具回合上限消费，
 * 引擎无该字段消费）。
 *
 * 语义对齐壳侧能力命令：记录是「整体存储」——get 只读 + 缺省字段注入，
 * put 先读既有记录再并入（单字段写不覆盖其它字段），字段白名单校验失败
 * 不落盘。除已具名字段外的键原样透传保留（宿主扩展登记用途）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 能力记录（除下述已具名字段外的键原样透传保留）。 */
export interface CapabilityRecord {
  max_tool_rounds?: number;
  auto_approve_tools: string[];
  auto_approve_all_review: boolean;
  [key: string]: unknown;
}

/** 已移除语义的历史键（读档丢弃，不回显不落盘：档位门禁已取消）。 */
const DEPRECATED_KEYS = ['simulation_tier'] as const;

/** 缺省能力记录（auto 字段出厂空集：不勾选即不预授权，最保守）。 */
export function defaultCapabilityRecord(): CapabilityRecord {
  return {
    auto_approve_tools: [],
    auto_approve_all_review: false,
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
  for (const [key, value] of Object.entries(data)) {
    if ((DEPRECATED_KEYS as readonly string[]).includes(key)) continue;
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
