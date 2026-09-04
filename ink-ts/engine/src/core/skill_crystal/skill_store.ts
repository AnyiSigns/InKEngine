/**
 * SkillStore：技能存储（注入 seam 的薄封装；默认内存 seam，生产由宿主
 * 注入 sqlite 实现）。沿 fingerprint_cache/edge_evidence 存储先例：
 * core 零 IO、默认 InMemory、now 时间 seam 缺省确定值。
 *
 * Python aiosqlite 的依赖 fail-fast（ENG1-11：缺失 = 装配期显式拒绝，不拖到
 * 运行期静默失效）在 TS 面由「依赖探测在宿主 sqlite seam 注入侧」承接——
 * core 本身零依赖，宿主接 sqlite 库时于装配期探测即报（同纪律）。
 */

import { StorageError } from '../errors.js';
import { stableStringify } from '../json.js';
import { InMemorySkillStorage } from './in_memory.js';
import type { SkillRow, SkillStorage } from './storage_seam.js';
import { SkillEntry } from './skill_entry.js';

/** 行 → 条目（复杂字段按 JSON 反序列化；形状与 Python 行转换一致）。 */
function row_to_entry(row: SkillRow): SkillEntry {
  const rawContract = JSON.parse(row.contract_snapshot) as Array<[string, string]>;
  const contractSnapshot = rawContract.map(
    (pair) => [pair[0] ?? '', pair[1] ?? ''] as const,
  );
  return new SkillEntry({
    name: String(row.name),
    version: Number(row.version),
    domain: String(row.domain),
    fingerprint: String(row.fingerprint),
    kind: String(row.kind),
    path: JSON.parse(row.path_data) as Record<string, unknown>,
    contract_snapshot: contractSnapshot,
    evidence_snapshot: JSON.parse(
      row.evidence_snapshot,
    ) as readonly Record<string, unknown>[],
    model_id: String(row.model_id),
    hit_count: Number(row.hit_count),
    fail_count: Number(row.fail_count),
    test_report: JSON.parse(row.test_report) as Record<string, unknown>,
    source_path: String(row.source_path),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  });
}

/** 条目 → 行（复杂字段规范 JSON 序列化：路径/证据 sort_keys，镜像 Python）。 */
function entry_to_row(entry: SkillEntry, updated_at: number): SkillRow {
  return {
    name: entry.name,
    version: entry.version,
    domain: entry.domain,
    fingerprint: entry.fingerprint,
    kind: entry.kind,
    path_data: stableStringify(entry.path),
    contract_snapshot: JSON.stringify(
      entry.contract_snapshot.map((pair) => [pair[0], pair[1]]),
    ),
    evidence_snapshot: stableStringify(
      entry.evidence_snapshot.map((row) => ({ ...row })),
    ),
    model_id: entry.model_id,
    hit_count: entry.hit_count,
    fail_count: entry.fail_count,
    test_report: JSON.stringify(entry.test_report),
    source_path: entry.source_path,
    created_at: entry.created_at,
    updated_at,
  };
}

/** SkillStore 构造选项（存储 seam + 时间 seam；now 缺省确定值 0）。 */
export interface SkillStoreOptions {
  storage?: SkillStorage;
  now?: number | null;
}

/** 技能存储（派生独立存储；同名同版本整行替换，版本递增由调用方负责）。 */
export class SkillStore {
  readonly #storage: SkillStorage;
  readonly #now: number | null;
  #closed = false;

  constructor(opts: SkillStoreOptions = {}) {
    this.#storage = opts.storage ?? new InMemorySkillStorage();
    this.#now = opts.now ?? null;
  }

  /** 时间源：注入 now 优先，缺省确定值 0（core 零时钟可复现）。 */
  #ts(): number {
    return this.#now ?? 0;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new StorageError('技能存储已关闭（close() 后不可再读写）');
    }
  }

  /** 写入技能（同 (name, version) 整行替换；updated_at 刷新为当前时间）。 */
  async upsert(entry: SkillEntry): Promise<void> {
    this.#assertOpen();
    const ts = this.#ts();
    try {
      await this.#storage.upsert_row(entry_to_row(entry, ts));
    } catch (exc) {
      throw new StorageError(`技能写入失败: ${String(exc)}`);
    }
  }

  /** 按名取技能（version 缺省 = 取最新版本）。 */
  async get(name: string, version?: number | null): Promise<SkillEntry | null> {
    this.#assertOpen();
    try {
      const row =
        version === null || version === undefined
          ? await this.#storage.lookup_latest_row(name)
          : await this.#storage.lookup_row(name, version);
      return row === null ? null : row_to_entry(row);
    } catch (exc) {
      throw new StorageError(`技能读取失败: ${String(exc)}`);
    }
  }

  /** 按来源指纹取最新版本（结晶去重/版本递增判定用）。 */
  async get_by_fingerprint(fingerprint: string): Promise<SkillEntry | null> {
    this.#assertOpen();
    try {
      const row = await this.#storage.lookup_latest_row_by_fingerprint(fingerprint);
      return row === null ? null : row_to_entry(row);
    } catch (exc) {
      throw new StorageError(`技能读取失败: ${String(exc)}`);
    }
  }

  /** 枚举技能（domain 缺省 = 全域；按名+版本升序确定性序）。 */
  async list(domain?: string | null): Promise<SkillEntry[]> {
    this.#assertOpen();
    try {
      const rows = await this.#storage.list_rows(domain ?? null);
      return rows.map((row) => row_to_entry(row));
    } catch (exc) {
      throw new StorageError(`技能枚举失败: ${String(exc)}`);
    }
  }

  /** 删除某技能全部版本（派生数据可重建）。 */
  async delete(name: string): Promise<boolean> {
    this.#assertOpen();
    try {
      return await this.#storage.remove_rows(name);
    } catch (exc) {
      throw new StorageError(`技能删除失败: ${String(exc)}`);
    }
  }

  /** 技能计数（含全部版本；domain 缺省 = 全域）。 */
  async count(domain?: string | null): Promise<number> {
    this.#assertOpen();
    try {
      return await this.#storage.count_rows(domain ?? null);
    } catch (exc) {
      throw new StorageError(`技能计数失败: ${String(exc)}`);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#storage.close !== undefined) {
      await this.#storage.close();
    }
  }
}
