/**
 * 技能默认内存存储实现（InMemorySkillStorage）。
 *
 * 纯内存 seam：零 IO、零第三方依赖，满足无宿主注入场景零依赖运行与
 * 单测确定性；生产由宿主注入 sqlite 实现（沿 fingerprint_cache/edge_evidence
 * 同构）。行级语义与 Python `:memory:` sqlite 逐条对齐：(name, version)
 * 复合主键顶替、按名/按指纹取最新版、按 name+version 升序枚举、按名删全版。
 */

import type { SkillRow, SkillStorage } from './storage_seam.js';

/** 纯内存 seam；行级语义与 Python sqlite 实现逐条对齐。 */
export class InMemorySkillStorage implements SkillStorage {
  readonly #rows = new Map<string, SkillRow>();

  #key(name: string, version: number): string {
    return `${name}\u0000${version}`;
  }

  #latestBy(
    predicate: (row: SkillRow) => boolean,
  ): Promise<SkillRow | null> {
    let latest: SkillRow | null = null;
    for (const row of this.#rows.values()) {
      if (!predicate(row)) continue;
      if (latest === null || row.version > latest.version) latest = { ...row };
    }
    return Promise.resolve(latest);
  }

  async upsert_row(row: SkillRow): Promise<void> {
    this.#rows.set(this.#key(row.name, row.version), { ...row });
  }

  async lookup_row(name: string, version: number): Promise<SkillRow | null> {
    const row = this.#rows.get(this.#key(name, version));
    return row === undefined ? null : { ...row };
  }

  async lookup_latest_row(name: string): Promise<SkillRow | null> {
    return this.#latestBy((row) => row.name === name);
  }

  async lookup_latest_row_by_fingerprint(
    fingerprint: string,
  ): Promise<SkillRow | null> {
    return this.#latestBy((row) => row.fingerprint === fingerprint);
  }

  async list_rows(domain: string | null = null): Promise<SkillRow[]> {
    const rows: SkillRow[] = [];
    for (const row of this.#rows.values()) {
      if (domain === null || domain === '' || row.domain === domain) {
        rows.push({ ...row });
      }
    }
    rows.sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.version - b.version;
    });
    return rows;
  }

  async remove_rows(name: string): Promise<boolean> {
    let removed = false;
    for (const key of [...this.#rows.keys()]) {
      const row = this.#rows.get(key);
      if (row !== undefined && row.name === name) {
        this.#rows.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  async count_rows(domain: string | null = null): Promise<number> {
    let n = 0;
    for (const row of this.#rows.values()) {
      if (domain === null || domain === '' || row.domain === domain) n += 1;
    }
    return n;
  }
}
