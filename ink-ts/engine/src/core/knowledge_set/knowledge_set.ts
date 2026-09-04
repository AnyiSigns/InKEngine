/**
 * 知识集公开类（KnowledgeSet）：闸门落库 + 可移植 + 持久化 + 复用检索。
 *
 * 与 KnowledgeSetBase（knowledge_set_core.ts）组合成 knowledge_set.py
 * 单一类的完整公开形态：本文件承载落库闸门（样例测试非谈判项的存储
 * 边界强制）、导出/导入（跨部署迁移复用）、存储三后端共用的
 * knowledge:<user> 集合读写、复用检索（复用优先于生成，防知识膨胀）。
 */

import { FixtureGateError, GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';
import { PatchChain } from '../patch/patchChain.js';
import { KnowledgeEntry } from './knowledge_entry.js';
import { _cjk_bigrams, _has_cjk, knowledge_collection } from './knowledge_utils.js';
import {
  DEFAULT_SEARCH_LIMIT,
  KS_ERR_GATE_TYPE,
  _CHAIN_KEY,
  type KnowledgeGateLike,
  type KnowledgeStorage,
} from './_types.js';
import { KnowledgeSetBase, type KnowledgeSetBaseOptions } from './knowledge_set_core.js';

export { KnowledgeEntry };
export { knowledge_collection, _cjk_bigrams, _has_cjk } from './knowledge_utils.js';
export type { KnowledgeEntryOptions } from './knowledge_entry.js';

export { KnowledgeSetBase, buildPrecisePatch } from './knowledge_set_core.js';
export type { KnowledgeSetBaseOptions, InnerPath } from './knowledge_set_core.js';
export type { KnowledgeGateLike, KnowledgeStorage, PatchChain };

/**
 * 用户知识集：种子注入 + 演化补丁链 + 分层晋升 + 可移植。
 *
 * 数据形态：补丁链 base = {"entries": {id: 条目数据}}，演化 = 追加补丁
 * （新增 replace、修正 replace 同路径、删除 delete）——链即全部变更历史
 * （append-only 可回退）；快照 = assemble 产物（可导出）。
 */
export class KnowledgeSet extends KnowledgeSetBase {
  constructor(user_id: string, options: KnowledgeSetBaseOptions = {}) {
    super(user_id, options);
  }

  // ── 落库闸门（样例测试非谈判项的存储边界强制）──

  /** 落库闸门：注入闸门实例（KnowledgeGateLike）时，条目在写入前必须
   *  通过 L1 准入 → L2 效果评估 → L3 目标筛选——任一关不过即抛
   *  FixtureGateError，条目不落库。未注入闸门 = 调用方自行把关（种子
   *  注入等已验证发布物路径），机制不替策略设默认。 */
  async verify_through_gate(
    entry: KnowledgeEntry,
    options: {
      gate?: KnowledgeGateLike | null;
      schema?: unknown;
      fixtures?: unknown;
      regression?: unknown;
      new_metrics?: Record<string, number> | null;
      old_metrics?: Record<string, number> | null;
    } = {},
  ): Promise<void> {
    const gate = options.gate ?? null;
    if (gate === null) return;
    // duck-check：闸门实例以 check 方法为形（knowledge_gate 未迁 core 前
    // 的兼容判定；形态非法显式拒绝，不静默放行）
    if (typeof gate.check !== 'function') {
      throw new GraphDefinitionError(
        `[${KS_ERR_GATE_TYPE}] 落库闸门形态非法（须为知识闸门实例）`,
      );
    }
    const [l1, l2, l3] = await gate.check(entry, {
      schema: options.schema,
      fixtures: options.fixtures,
      new_metrics: options.new_metrics ?? null,
      old_metrics: options.old_metrics ?? null,
      regression: options.regression,
    });
    if (!(l1.passed && l2.passed && l3.passed)) {
      throw new FixtureGateError(
        `知识条目 ${entry.id} 未通过落库闸门` +
          `（L1: ${l1.errors || '通过'} / L2: ${l2.note || '通过'} / ` +
          `L3: ${l3.reason || '通过'}）`,
      );
    }
  }

  /** 带闸门落库：写入前过三层闸门（样例不绿在存储边界即被拒绝）。
   *
   * 闸门为异步评估（L2 含完整样例执行），与同步的 add 分离为独立入口——
   * 种子注入等已验证发布物走同步 add（幂等且不重复评估），演化产物走
   * 本入口（非谈判项 fail-closed）。 */
  async add_gated(
    entry: KnowledgeEntry,
    options: {
      gate: KnowledgeGateLike;
      schema?: unknown;
      fixtures?: unknown;
      regression?: unknown;
    },
  ): Promise<KnowledgeEntry> {
    await this.verify_through_gate(entry, {
      gate: options.gate,
      schema: options.schema,
      fixtures: options.fixtures,
      regression: options.regression,
    });
    return this.add(entry);
  }

  // ── 可移植（导出/导入：内容永远可带走）──

  /** 导出为补丁链数据（跨部署迁移复用；链 = 全部演化历史）。
   *
   * 导出内容 = 机制数据（补丁链），权属使用方——「可移植」是权属边界
   * 的内置承诺：引擎管机制，内容永远可带走。 */
  export(): { [key: string]: unknown } {
    return this.chain.to_dict() as unknown as { [key: string]: unknown };
  }

  /** 从导出数据重建知识集（round-trip：export → import 无损还原）。
   *
   * 非法导出数据显式拒绝（缺 base/patches 形态），不静默建空集。 */
  static from_export(
    user_id: string,
    data: unknown,
    options: { storage?: KnowledgeStorage | null } = {},
  ): KnowledgeSet {
    if (!isRecord(data)) {
      throw new GraphDefinitionError('知识集导出数据非法（缺 base 结构）');
    }
    if (!isRecord(data.base)) {
      throw new GraphDefinitionError('知识集导出数据非法（缺 base 结构）');
    }
    const chain = PatchChain.from_dict(data as unknown as Parameters<typeof PatchChain.from_dict>[0]);
    return new KnowledgeSet(user_id, { storage: options.storage ?? null, chain });
  }

  // ── 持久化（存储三后端共用：knowledge:<user> 集合）──

  /** 持久化集合名（knowledge:<user_id>）。
   *
   * 守卫豁免对齐兼容点：旁路写守卫按集合名（精确/前缀）判定，宿主侧
   * 应对齐本名（knowledge:<user> 与 knowledge_set 字面量的豁免失效问题
   * 的修复依据）——消费方用本 getter 而非硬编码字面量。 */
  get collection(): string {
    return knowledge_collection(this.user_id);
  }

  /** 落库（补丁链写入存储；storage=null 时跳过——纯内存集）。 */
  async save(): Promise<void> {
    if (this.storage === null) return;
    await this.storage.put_record(
      knowledge_collection(this.user_id),
      _CHAIN_KEY,
      this.export(),
    );
  }

  /** 从存储读回（无记录 = 空集；存储不可用 = 空集——种子注入由使用方
   *  在初始化时调用 seed_knowledge_set）。 */
  static async load(
    user_id: string,
    options: { storage?: KnowledgeStorage | null } = {},
  ): Promise<KnowledgeSet> {
    const storage = options.storage ?? null;
    if (storage === null) return new KnowledgeSet(user_id);
    const data = await storage.get_record(knowledge_collection(user_id), _CHAIN_KEY);
    if (data === null || data === undefined) return new KnowledgeSet(user_id);
    return KnowledgeSet.from_export(user_id, data, { storage });
  }

  // ── 复用检索（复用优先于生成，防知识膨胀）──

  /** 相似任务检索：标题/标签/数据文本的关键词命中 + 可信度排序。
   *
   * 检索 = 复用优先于生成的第一步（AgentFactory 教训）：相似任务先检索
   * 已有条目，命中复用而非从头蒸馏。实现为关键词子串匹配（无语义检索
   * 时仍可用的确定性基线；语义检索为可选扩展，可注入）。
   *
   * 中文长句缺陷修复：装配 query 为回合输入全文（中文无空格边界），空格
   * 分词会整段塌缩为 1 个超长 token，全词交集必然 0 命中。修复 = CJK 长
   * token 按 2-gram 滑窗展开为关键片段（子串交集降级为「任一 2-gram 命中」），
   * 并按命中片段数评分——短 token（≤2 字符）/非 CJK 保持整串子串语义
   * （多词 AND 不变），中文长 query 不再必然 0 命中。
   *
   * 检索作用域 = 活跃索引（归档条目默认不参与；include_archived=true 可
   * 显式检索归档条目）。 */
  search(
    query: string,
    options: {
      level?: string | null;
      kind?: string | null;
      limit?: number;
      include_archived?: boolean;
    } = {},
  ): KnowledgeEntry[] {
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    if (!query || limit <= 0) return [];
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const level = options.level ?? null;
    const kind = options.kind ?? null;
    const includeArchived = options.include_archived ?? false;
    // 命中数评分：主键（命中片段越多越靠前），次键 credibility。
    // 命中数=0 的 token 不阻断候选（长 query 部分命中可进候选），但完全
    // 无命中的 token 使该条目不参与——多词 AND 语义仅对「全 token 都有
    // 命中片段」的条目完整生效。
    const scored: Array<[number, KnowledgeEntry]> = [];
    for (const entry of this.entries(level, { include_archived: includeArchived })) {
      if (kind !== null && entry.kind !== kind) continue;
      const haystack = [
        entry.title,
        ...entry.tags,
        entry.id,
        JSON.stringify(entry.data),
      ]
        .join(' ')
        .toLowerCase();
      let totalHits = 0;
      let zeroHitTokens = 0;
      for (const token of tokens) {
        const grams =
          _has_cjk(token) && token.length > 2 ? _cjk_bigrams(token) : [token];
        let hits = 0;
        for (const gram of grams) {
          if (haystack.includes(gram)) hits += 1;
        }
        totalHits += hits;
        if (hits === 0) zeroHitTokens += 1;
      }
      if (zeroHitTokens > 0) continue;
      scored.push([totalHits, entry]);
    }
    scored.sort(
      (a, b) =>
        b[0] - a[0] ||
        b[1].credibility - a[1].credibility ||
        b[1].usage_count - a[1].usage_count,
    );
    return scored.slice(0, limit).map((pair) => pair[1]);
  }
}