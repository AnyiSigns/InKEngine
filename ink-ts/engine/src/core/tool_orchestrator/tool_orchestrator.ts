/**
 * 工具调配器与工具轨迹存储（按子任务动态组装本轮工具集的机制层）。
 *
 * 调配思想（上下文调配器的同构升级）：工具集 = 带元数据的候选池——
 * 任务相关度 = relevance、调用频率/可信度 = weight、预算 = 工具集上限。
 * 确定性选取（零 LLM 调用），宿主可注入自定义打分策略——换策略不改
 * 装配，与 ContextMixer 的替换语义一致。
 *
 * 工具调用轨迹 = 信号源（经验闭环的原始数据）：成功组合 → 蒸馏为推荐
 * 工具集、踩坑/误用 → 沉淀为工具使用规则（蒸馏发生在知识集孵化层，
 * 本模块只提供 append-only 轨迹存储与查询原语，不含任何业务语义）。
 *
 * 副作用纪律：存储/时间/随机一律走 seam（TraceRecordsStore / Clock /
 * UuidFn，见 _types.ts），缺省确定值——core 纯逻辑，单测可复现。
 *
 * 状态标注（机制就绪 / 宿主接线点待定）：ToolSelector/ToolTraceStore 为
 * 宿主装配按需接线能力——runtime 已装配 ToolSelector（_runtime_specs /
 * _runtime_assemble）；ToolTraceStore 暂无 src 消费方，轨迹 sink 位在
 * ToolPipeline.trace_sink（构建期注入，缺省 null 不落轨迹），records
 * 后端由宿主注入。
 */

import { strip_sensitive } from '../security/security.js';
import type { ToolSpec } from '../llm/tools.js';
import {
  DEFAULT_MAX_TOOLS,
  DEFAULT_MIN_SCORE,
  DEFAULT_UUID_HEX,
  ToolCandidate,
  ToolTrace,
} from './_types.js';
import type {
  ToolMatchStrategy,
  ToolScoring,
  ToolTraceStoreOptions,
  TraceRecordsStore,
  UuidFn,
} from './_types.js';

/** 确定性默认调配：按调配分排序、门槛丢弃、预算截断（Python
 *  WeightedToolScorer 移植）。
 *
 * 规则：
 * 1. 跨工具去重（同名只保留调配分最高者——同一工具重复注册取最强声明）；
 * 2. score ≥ min_score 才可入选（低于门槛 = 近似噪音，丢弃）；
 * 3. 按 (优先级降序, 调配分降序) 排序，截断至预算上限。
 *
 * 确定性 = 同一输入必得同一输出（可缓存、可断言、零 LLM 调用）。
 */
export class WeightedToolScorer implements ToolScoring {
  readonly min_score: number;

  constructor(options: { min_score?: number } = {}) {
    const min_score = options.min_score ?? DEFAULT_MIN_SCORE;
    if (min_score < 0) {
      throw new RangeError(`工具入选门槛不能为负: ${min_score}`);
    }
    this.min_score = min_score;
  }

  select(candidates: readonly ToolCandidate[], max_tools: number): ToolSpec[] {
    if (max_tools < 0) {
      throw new RangeError(`工具集预算不能为负: ${max_tools}`);
    }
    if (max_tools === 0 || candidates.length === 0) {
      return [];
    }
    // 同名去重：取 (priority, score) 字典序更高者（平局保留先注册者）
    const best = new Map<string, ToolCandidate>();
    for (const candidate of candidates) {
      const prev = best.get(candidate.spec.name);
      if (prev === undefined || beats(candidate, prev)) {
        best.set(candidate.spec.name, candidate);
      }
    }
    const ranked: ToolCandidate[] = [];
    for (const candidate of best.values()) {
      if (candidate.score() >= this.min_score) {
        ranked.push(candidate);
      }
    }
    ranked.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.score() - a.score();
    });
    return ranked.slice(0, max_tools).map((c) => c.spec);
  }
}

/** (priority, score) 字典序比较（a 优于 b 时成立；平局 = 不优于）。
 *  Python 元组比较的 TS 等价：先比优先级再比调配分。 */
function beats(a: ToolCandidate, b: ToolCandidate): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.score() > b.score();
}

/** 工具调配器构造选项。 */
export interface ToolSelectorOptions {
  max_tools?: number;
  scorer?: ToolScoring;
  baseline_names?: readonly string[];
  match_strategy?: ToolMatchStrategy;
}

/** 工具调配器门面：候选池 → 预算内本轮工具集（策略可注入）。
 *
 * 与 ContextMixer 同构：默认走确定性调配（WeightedToolScorer），宿主
 * 可注入自定义策略（如 LLM 语义匹配后的候选加权）——换策略不改装配。
 *
 * 工具注入瘦身接线：保底工具 priority 高 + 调用权重（baseline_names
 * 声明的工具自动获得 priority 与 weight 加成，确保常驻工具优先入选）。
 */
export class ToolSelector {
  /** 保底工具加成（priority 偏移 / weight 倍率） */
  static readonly BASELINE_PRIORITY_BOOST = 10;
  static readonly BASELINE_WEIGHT_BOOST = 2.0;

  readonly max_tools: number;
  readonly scorer: ToolScoring;
  readonly baseline_names: ReadonlySet<string>;
  readonly match_strategy: ToolMatchStrategy | null;

  constructor(options: ToolSelectorOptions = {}) {
    const max_tools = options.max_tools ?? DEFAULT_MAX_TOOLS;
    if (max_tools < 0) {
      throw new RangeError(`工具集预算不能为负: ${max_tools}`);
    }
    this.max_tools = max_tools;
    this.scorer = options.scorer ?? new WeightedToolScorer();
    this.baseline_names = new Set<string>(options.baseline_names ?? []);
    this.match_strategy = options.match_strategy ?? null;
  }

  /** 本轮工具集选取：候选 → 预算内工具清单（确定性，零 LLM 调用）。 */
  select(candidates: readonly ToolCandidate[], max_tools?: number): ToolSpec[] {
    const budget = max_tools === undefined ? this.max_tools : max_tools;
    let decorated = this.#decorateBaselines(candidates);
    if (this.match_strategy !== null) {
      decorated = this.match_strategy.apply(decorated);
    }
    return this.scorer.select(decorated, budget);
  }

  /** 保底工具加成：priority 偏移 + weight 倍率（仅对声明的基线名生效）。 */
  #decorateBaselines(candidates: readonly ToolCandidate[]): readonly ToolCandidate[] {
    if (this.baseline_names.size === 0) {
      return candidates;
    }
    const result: ToolCandidate[] = [];
    for (const candidate of candidates) {
      if (this.baseline_names.has(candidate.spec.name)) {
        result.push(
          new ToolCandidate({
            spec: candidate.spec,
            relevance: candidate.relevance,
            weight: candidate.weight * ToolSelector.BASELINE_WEIGHT_BOOST,
            priority: candidate.priority + ToolSelector.BASELINE_PRIORITY_BOOST,
          }),
        );
      } else {
        result.push(candidate);
      }
    }
    return result;
  }
}

/** 工具轨迹存储（append-only 记录，蒸馏层消费的信号源）。
 *
 * 存储后盾 = 通用存储服务（memory/sqlite/postgres 共用，与记忆存储
 * 同构）；查询按工具名过滤 + 按时间倒序。轨迹只增不删（信号可完整
 * 回放，与引擎 Event Sourcing 哲学一致）。core 只依赖 records 通道两
 * 原语（TraceRecordsStore），实现由宿主注入。
 */
export class ToolTraceStore {
  readonly #storage: TraceRecordsStore;
  readonly #collection: string;
  readonly #uuid: UuidFn;

  constructor(storage: TraceRecordsStore, options: ToolTraceStoreOptions = {}) {
    this.#storage = storage;
    this.#collection = options.collection ?? 'tool_traces';
    this.#uuid = options.uuid ?? (() => DEFAULT_UUID_HEX);
  }

  /** 追加一条轨迹（同 id 覆写 = 补录，幂等安全）。
   *
   * 落库前对参数脱敏：凭据类参数不得随轨迹持久化留存（strip_sensitive
   * 纯函数，无敏感键时零拷贝返回原对象）。
   */
  async record(trace: ToolTrace): Promise<string> {
    const trace_id = trace.id ?? `${trace.tool}:${this.#uuid()}`;
    const data = trace.to_dict();
    data['args'] = strip_sensitive(data['args']);
    data['id'] = trace_id; // 生成 id 回写记录（查询还原可关联原始轨迹）
    await this.#storage.put_record(this.#collection, trace_id, data);
    return trace_id;
  }

  /** 轨迹查询：按工具名/成败过滤，时间倒序（最新在前）。
   *
   * 当前实现在行内完成全量载入后的过滤与排序（limit 已生效）。在高吞吐/
   * 无界增长下，全量载入会带来无界内存占用——将过滤下推到存储层（查询期
   * 按 tool/ok 过滤 + 按时间分页）为规模演进项，本模块不重构存储层，
   * 保持查询语义不变。
   */
  async list(
    options: { tool?: string | null; ok?: boolean | null; limit?: number | null } = {},
  ): Promise<ToolTrace[]> {
    const records = await this.#storage.list_records(this.#collection);
    let traces = records.map((record) => ToolTrace.from_dict(record));
    if (options.tool !== undefined && options.tool !== null) {
      traces = traces.filter((t) => t.tool === options.tool);
    }
    if (options.ok !== undefined && options.ok !== null) {
      traces = traces.filter((t) => t.ok === options.ok);
    }
    traces.sort((a, b) => b.created_at - a.created_at);
    if (options.limit !== undefined && options.limit !== null) {
      traces = traces.slice(0, options.limit);
    }
    return traces;
  }
}

// ── 导出面（镜像 Python __all__；数据形态与 seam 类型集中放 _types.ts） ──
export {
  DEFAULT_MAX_TOOLS,
  DEFAULT_MIN_SCORE,
  DEFAULT_RELEVANCE,
  DEFAULT_UUID_HEX,
  ToolCandidate,
  ToolTrace,
} from './_types.js';
export type {
  Clock,
  ToolCandidateOptions,
  ToolMatchStrategy,
  ToolScoring,
  ToolTraceOptions,
  TraceRecordsStore,
  UuidFn,
} from './_types.js';