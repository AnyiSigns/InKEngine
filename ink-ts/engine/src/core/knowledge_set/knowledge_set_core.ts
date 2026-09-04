/**
 * 知识集内部基类（KnowledgeSetBase）：内存链装载 + 条目读写 + 生命周期。
 *
 * 文件拆分纪律（≤350 行/文件）：KnowledgeSet 公开类按机制分两部——本文件
 * 承载构造/快照读取/增删改/归档淘汰/晋升/调用留痕（纯内存链语义），
 * 闸门/可移植/持久化/复用检索落公开类（knowledge_set.ts）。公开形态与
 * 行为由两者组合保持与 knowledge_set.py 单一类一致。
 *
 * 持久化语义：add/update/record_usage 等只改内存链，落库 = 调用方显式
 * save（写 knowledge:<user> 集合）；注入 on_mutation 钩子 = 变更后立即
 * 同步回调调度落库，未注入 = 维持显式 save 语义（钩子不改变默认行为）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, type Json, type JsonRecord } from '../json.js';
import { PatchChain } from '../patch/patchChain.js';
import type { Path } from '../patch/types.js';
import { KnowledgeEntry } from './knowledge_entry.js';
import { _entry_path } from './knowledge_utils.js';
import {
  _LEVEL_ORDER,
  _LEVELS,
  _MAX_FAILURE_LOGS,
  _UNSET,
  type Clock,
  type KnowledgeStorage,
  isKnowledgeLevel,
} from './_types.js';

export type { Clock, Json, JsonRecord, KnowledgeStorage, Path };
export { _UNSET };

/** KnowledgeSetBase 构造选项（Python kw-only args 的 TS 映射）。 */
export interface KnowledgeSetBaseOptions {
  storage?: KnowledgeStorage | null;
  chain?: PatchChain | null;
  on_mutation?: (() => void) | null;
  /** 时间注入面：updated_at 缺省确定值（未注入 = 0）。 */
  clock?: Clock;
}

/** 精准补丁路径（data 内嵌套段；dict 段 string、list 段 number）。 */
export type InnerPath = readonly (string | number)[];

/**
 * 精准补丁构造（knowledge_signals.build_precise_patch 兼容的单一契约点：
 * 蒸馏侧精准补丁与本处修正语义同源——只校验路径后原样声明，不重写整条）。
 */
export function buildPrecisePatch(
  path: InnerPath,
  value: unknown,
): { path: (string | number)[]; value: unknown } {
  if (path.length === 0) {
    throw new GraphDefinitionError('精准补丁路径不能为空');
  }
  return { path: [...path], value };
}

/** KnowledgeSetBase：内存链承载的条目读写与生命周期（见文件头拆分说明）。 */
export class KnowledgeSetBase {
  readonly user_id: string;
  readonly storage: KnowledgeStorage | null;
  readonly chain: PatchChain;
  readonly on_mutation: (() => void) | null;
  readonly clock: Clock;

  constructor(user_id: string, options: KnowledgeSetBaseOptions = {}) {
    this.user_id = user_id;
    this.storage = options.storage ?? null;
    this.chain = options.chain ?? new PatchChain();
    this.on_mutation = options.on_mutation ?? null;
    this.clock = options.clock ?? {};
  }

  protected now(): number {
    return (this.clock.now ?? DEFAULT_NOW)();
  }

  /** 变更钩子（内存链变更后的同步回调；异常不阻断主流程，core 无日志面）。 */
  protected notify_mutated(): void {
    if (this.on_mutation !== null && this.on_mutation !== undefined) {
      try {
        this.on_mutation();
      } catch {
        // 钩子失败是宿主副作用路径：链变更已完成，异常不阻断演化
      }
    }
  }

  // ── 条目读取（快照 = 补丁链组装产物）──

  /** 当前快照的条目清单（按层级过滤可选；升序 = 插入序稳定）。
   *
   * 默认只返回活跃条目（归档 = 移出活跃索引，可恢复——生命周期语义：
   * 低使用归档不删除）；include_archived=true 取全量。 */
  entries(
    level?: string | null,
    options: { include_archived?: boolean } = {},
  ): KnowledgeEntry[] {
    if (level !== null && level !== undefined && !isKnowledgeLevel(level)) {
      throw new GraphDefinitionError(`未知知识层级: ${level}`);
    }
    const snapshot = this.chain.assemble();
    const rawEntries = snapshot.entries;
    if (!isRecord(rawEntries)) return [];
    const entries: KnowledgeEntry[] = [];
    for (const record of Object.values(rawEntries)) {
      if (isRecord(record)) entries.push(KnowledgeEntry.from_dict(record));
    }
    const includeArchived = options.include_archived ?? false;
    const active = includeArchived ? entries : entries.filter((e) => !e.archived);
    const filtered =
      level === null || level === undefined ? active : active.filter((e) => e.level === level);
    return filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 归档条目清单（低使用移出活跃索引后的可恢复视图）。 */
  archived_entries(level?: string | null): KnowledgeEntry[] {
    return this.entries(level, { include_archived: true }).filter((e) => e.archived);
  }

  /** 按 id 取条目（不存在返回 null）。 */
  get(entry_id: string): KnowledgeEntry | null {
    const snapshot = this.chain.assemble();
    const raw = isRecord(snapshot.entries)
      ? snapshot.entries[entry_id]
      : undefined;
    return raw !== undefined && isRecord(raw) ? KnowledgeEntry.from_dict(raw) : null;
  }

  // ── 条目写（补丁链 append-only：演化 = 新补丁，回退 = 旧版本）──

  /** 新增条目（补丁链 append-only：replace 到 entries/<id>）。
   *
   * 同 id 已存在 = 重复添加（防静默覆盖既有知识，应走 update 修正）。
   * 本入口为同步直落（种子注入等已验证发布物路径）；演化产物须过
   * 三层闸门，经 add_gated（样例测试非谈判项 fail-closed）。 */
  add(entry: KnowledgeEntry): KnowledgeEntry {
    if (this.get(entry.id) !== null) {
      throw new GraphDefinitionError(
        `知识条目已存在（修正请用 update）: ${entry.id}`,
      );
    }
    this.chain.apply({
      op: 'replace',
      path: _entry_path(entry.id),
      value: entry.to_dict() as unknown as Json,
    });
    this.notify_mutated();
    return entry;
  }

  /** 修正条目（精准补丁：只替换变更字段，不重写整条知识）。
   *
   * 与蒸馏「精准补丁（replace 语义，只改对应段落）」对齐，三种修正形态
   * 互不混叠：data = 结构化字段级替换（合并进现有 data 顶层）；path+value
   * = 嵌套精准补丁（沿路径只改 data 内对应段落，兄弟字段不受影响，落链
   * 为深路径 replace 补丁）；changes = 顶层字段替换。旧值均在链历史中，
   * 回退可取；data 与 path 互斥（一次修正只走一种精准语义）。 */
  update(
    entry_id: string,
    options: {
      data?: JsonRecord | null;
      path?: InnerPath | null;
      value?: unknown;
      changes?: Record<string, unknown>;
    } = {},
  ): KnowledgeEntry {
    const existing = this.get(entry_id);
    if (existing === null) {
      throw new GraphDefinitionError(`知识条目不存在: ${entry_id}`);
    }
    const hasData = options.data !== null && options.data !== undefined;
    const hasPath = options.path !== null && options.path !== undefined;
    if (hasData && hasPath) {
      throw new GraphDefinitionError(
        `知识条目 ${entry_id} 的修正须在 data 与 path 二选一`,
      );
    }
    if (hasPath) {
      const path = options.path as InnerPath;
      if (path.length === 0) {
        throw new GraphDefinitionError(`知识条目 ${entry_id} 的精准补丁路径不能为空`);
      }
      // 值哨兵语义：显式 null 合法（「传 None」），只有缺传（_UNSET）才拒绝
      if (!('value' in options)) {
        throw new GraphDefinitionError(`知识条目 ${entry_id} 的精准补丁缺 value`);
      }
      const inner = buildPrecisePatch(path, options.value);
      this.chain.apply({
        op: 'replace',
        path: [..._entry_path(entry_id), 'data', ...inner.path],
        value: inner.value as unknown as Json,
      });
      this.chain.apply({
        op: 'replace',
        path: [..._entry_path(entry_id), 'updated_at'],
        value: this.now(),
      });
      const entry = this.get(entry_id);
      if (entry === null) {
        // 链形态保证存在；兜底防御
        throw new GraphDefinitionError(`知识条目 ${entry_id} 精准补丁后不可读`);
      }
      this.notify_mutated();
      return entry;
    }
    const updated = existing.to_dict();
    if (hasData) {
      if (!isRecord(options.data)) {
        throw new GraphDefinitionError(`知识条目 ${entry_id} 的修正 data 须为 dict`);
      }
      updated.data = { ...existing.data, ...(options.data as JsonRecord) };
    }
    if (options.changes !== undefined) {
      for (const [key, value] of Object.entries(options.changes)) {
        if (key === 'id' || key === 'created_at') {
          throw new GraphDefinitionError(
            `知识条目 ${entry_id} 的 ${key} 为身份字段，不可修正`,
          );
        }
        updated[key] = value as Json;
      }
    }
    updated.updated_at = this.now();
    this.chain.apply({
      op: 'replace',
      path: _entry_path(entry_id),
      value: updated,
    });
    const entry = KnowledgeEntry.from_dict(updated);
    this.notify_mutated();
    return entry;
  }

  /** 删除条目（补丁链 delete，幂等：不存在返回 false）。 */
  remove(entry_id: string): boolean {
    if (this.get(entry_id) === null) return false;
    this.chain.apply({ op: 'delete', path: _entry_path(entry_id) });
    this.notify_mutated();
    return true;
  }

  // ── 归档/淘汰（生命周期 = 归档不删除：低使用移出活跃索引，可恢复）──

  /** 归档条目：移出活跃索引（entries/search 不再命中），不删除。
   *
   * 与风险表「条目归档/淘汰机制（低使用 + 低引用/价值标记 → 归档不删除）」
   * 对齐：归档是生命周期管理（防规则集膨胀拖慢每次组装），数据与演化
   * 历史完整保留——unarchive 随时可恢复。 */
  archive(entry_id: string): KnowledgeEntry {
    const entry = this.get(entry_id);
    if (entry === null) {
      throw new GraphDefinitionError(`知识条目不存在: ${entry_id}`);
    }
    if (entry.archived) return entry;
    return this.update(entry_id, { changes: { archived: true } });
  }

  /** 恢复归档条目（重新进入活跃索引，内容与计数原样保留）。 */
  unarchive(entry_id: string): KnowledgeEntry {
    const entry = this.get(entry_id);
    if (entry === null) {
      throw new GraphDefinitionError(`知识条目不存在: ${entry_id}`);
    }
    if (!entry.archived) return entry;
    return this.update(entry_id, { changes: { archived: false } });
  }

  /** 调用留痕（usage_count/fail_count 累积 + 失败日志留存）。
   *
   * 失败日志 = 反思式变异的输入（进化工厂按近期失败定向修订）——留痕
   * 截尾保留最近 _MAX_FAILURE_LOGS 条，防无限膨胀。 */
  record_usage(entry_id: string, options: { failed?: boolean; log?: string } = {}): void {
    const existing = this.get(entry_id);
    if (existing === null) return;
    const failed = options.failed ?? false;
    const log = options.log ?? '';
    const changes: Record<string, unknown> = {
      usage_count: existing.usage_count + 1,
      updated_at: this.now(),
    };
    if (failed) {
      changes.fail_count = existing.fail_count + 1;
      if (log) {
        // 截尾保留最近 _MAX_FAILURE_LOGS 条：旧段取末 N-1 条 + 新日志
        changes.failure_logs = [
          ...existing.failure_logs.slice(-(_MAX_FAILURE_LOGS - 1)),
          log,
        ];
      }
    }
    this.update(entry_id, { changes });
  }

  // ── 分层晋升（先沉淀后压缩，顺序固定）──

  /** 晋升：条目层级 namespace 迁移（工作 → 项目 → 用户，不跳级）。
   *
   * 晋升是知识「毕业」：通用教训升到用户级供全部会话复用。条目 id 跨
   * 层级稳定（身份不变，层级字段迁移）；补丁链 replace 单点落链。 */
  promote(entry_id: string, options: { to_level?: string | null } = {}): KnowledgeEntry {
    const existing = this.get(entry_id);
    if (existing === null) {
      throw new GraphDefinitionError(`知识条目不存在: ${entry_id}`);
    }
    const currentRank = _LEVEL_ORDER[existing.level] ?? 0;
    if (options.to_level === null || options.to_level === undefined) {
      if (currentRank >= _LEVELS.length - 1) {
        throw new GraphDefinitionError(
          `知识条目 ${entry_id} 已处于最高层级（${existing.level}）`,
        );
      }
      // 秩已校验未越界：下一级必存在
      return this.update(entry_id, {
        changes: { level: _LEVELS[currentRank + 1] as string },
      });
    }
    const target = options.to_level;
    if (!isKnowledgeLevel(target)) {
      throw new GraphDefinitionError(`未知知识层级: ${target}`);
    }
    if (_LEVEL_ORDER[target] !== currentRank + 1) {
      throw new GraphDefinitionError(
        `晋升只能逐级向上（工作→项目→用户）: ${existing.level} → ${target}`,
      );
    }
    return this.update(entry_id, { changes: { level: target } });
  }
}

const DEFAULT_NOW = (): number => 0;