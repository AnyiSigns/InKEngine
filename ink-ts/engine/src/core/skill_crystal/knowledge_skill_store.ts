/**
 * KnowledgeSkillStore：技能存储 = 知识集 kind=path 条目的访问器
 * （合并容器，单一权威 = 知识集；skill_crystal.py KnowledgeSkillStore 移植）。
 *
 * 与 sqlite SkillStore 同接口（upsert/get/get_by_fingerprint/list/delete/
 * count/close），宿主装配期构造——knowledge_set 可后绑定（运行时 boot
 * 完成后挂到引擎知识集，装配期前后无需二阶段写入）。技能 = 知识集内
 * kind=path 条目：补丁链即唯一演化史（版本/回退/审计随知识集），持久化
 * 由知识集容器承接（本类零独立存储）。
 */

import { StorageError } from '../errors.js';
import { isRecord } from '../json.js';
import { KIND_PATH, KnowledgeEntry, KnowledgeSet } from '../knowledge_set/index.js';
import { knowledge_entry_to_skill, skill_to_knowledge_entry } from './knowledge_merge.js';
import { SkillEntry } from './skill_entry.js';

/** KnowledgeSkillStore 构造选项（now 为新增条目的 updated_at 时间 seam）。 */
export interface KnowledgeSkillStoreOptions {
  now?: number | null;
}

/** 条目 data.skill 载荷（非 skill 形态 = null，调用方显式拒绝）。 */
function skill_payload(entry: KnowledgeEntry): Record<string, unknown> | null {
  const data = entry.data['skill'];
  return isRecord(data) ? data : null;
}

/** 技能存储 = 知识集 kind=path 条目的访问器（见文件头拆分说明）。 */
export class KnowledgeSkillStore {
  #knowledge_set: KnowledgeSet | null;
  readonly #now: number | null;

  constructor(
    knowledge_set: KnowledgeSet | null = null,
    opts: KnowledgeSkillStoreOptions = {},
  ) {
    this.#knowledge_set = knowledge_set;
    this.#now = opts.now ?? null;
  }

  get knowledge_set(): KnowledgeSet | null {
    return this.#knowledge_set;
  }

  set knowledge_set(value: KnowledgeSet | null) {
    this.#knowledge_set = value;
  }

  #require(): KnowledgeSet {
    if (this.#knowledge_set === null) {
      throw new StorageError('技能存储未绑定知识集（知识集容器未就绪）');
    }
    return this.#knowledge_set;
  }

  #ts(): number {
    return this.#now ?? 0;
  }

  #entries(): KnowledgeEntry[] {
    return this.#require()
      .entries(null, { include_archived: true })
      .filter((entry) => entry.kind === KIND_PATH);
  }

  /** 写入技能（知识集条目：同名同版本整行替换 = update；新 = add）。 */
  async upsert(entry: SkillEntry): Promise<void> {
    const knowledge = skill_to_knowledge_entry(entry, { now: this.#ts() });
    const ks = this.#require();
    if (ks.get(knowledge.id) === null) {
      ks.add(knowledge);
    } else {
      ks.update(knowledge.id, {
        data: knowledge.data,
        changes: { credibility: knowledge.credibility },
      });
    }
  }

  /** 按名取技能（version 缺省 = 取最新版本）。 */
  async get(name: string, version?: number | null): Promise<SkillEntry | null> {
    let matches = this.#entries().filter((entry) => {
      const payload = skill_payload(entry);
      return payload !== null && payload['name'] === name;
    });
    if (matches.length === 0) return null;
    if (version !== null && version !== undefined) {
      matches = matches.filter((entry) => {
        const payload = skill_payload(entry);
        return payload !== null && Number(payload['version'] ?? 1) === version;
      });
      if (matches.length === 0) return null;
    } else {
      matches = [...matches].sort((a, b) => {
        const va = Number(skill_payload(a)?.['version'] ?? 1);
        const vb = Number(skill_payload(b)?.['version'] ?? 1);
        return vb - va;
      });
    }
    const chosen = matches[0];
    if (chosen === undefined) return null;
    return knowledge_entry_to_skill(chosen);
  }

  /** 按来源指纹取最新版本（结晶去重/版本递增判定用）。 */
  async get_by_fingerprint(fingerprint: string): Promise<SkillEntry | null> {
    const matches = this.#entries().filter((entry) => {
      const payload = skill_payload(entry);
      return payload !== null && payload['fingerprint'] === fingerprint;
    });
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const va = Number(skill_payload(a)?.['version'] ?? 1);
      const vb = Number(skill_payload(b)?.['version'] ?? 1);
      return vb - va;
    });
    const chosen = matches[0];
    if (chosen === undefined) return null;
    return knowledge_entry_to_skill(chosen);
  }

  /** 枚举技能（domain 缺省 = 全域；按名+版本升序确定性序）。 */
  async list(domain?: string | null): Promise<SkillEntry[]> {
    const skills = this.#entries().map((entry) => knowledge_entry_to_skill(entry));
    const filtered =
      domain === null || domain === undefined
        ? skills
        : skills.filter((skill) => skill.domain === domain);
    filtered.sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.version - b.version;
    });
    return filtered;
  }

  /** 删除某技能全部版本（知识集条目移除，补丁链留痕可回退）。 */
  async delete(name: string): Promise<boolean> {
    const ks = this.#require();
    let removed = false;
    for (const entry of this.#entries()) {
      const payload = skill_payload(entry);
      if (payload !== null && payload['name'] === name && ks.remove(entry.id)) {
        removed = true;
      }
    }
    return removed;
  }

  /** 技能计数（含全部版本；domain 缺省 = 全域）。 */
  async count(domain?: string | null): Promise<number> {
    const entries = this.#entries();
    if (domain === null || domain === undefined) return entries.length;
    return entries.filter((entry) => {
      const payload = skill_payload(entry);
      return payload !== null && payload['domain'] === domain;
    }).length;
  }

  async close(): Promise<void> {
    // 零独立存储——知识集容器负责持久化（无资源需释放）
  }
}
