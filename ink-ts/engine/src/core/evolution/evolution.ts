// gate: 超限(385 行) - 进化工厂状态机单段，机制内部分段已按职责文件化，主类拆开即破状态连续
/**
 * 进化工厂（知识结构级进化：反思式变异 + 三层闸门防退化）——evolution.py
 * 1:1 移植。失败率高的知识优先入队（次之长期未调用但仍有引用/价值标记，
 * 稳定者殿后）；反思式变异（变异输入 = 该知识近期失败日志，非成功轨迹）；
 * 变异体数量按调用频率/失败次数动态决定；进化产物同样过三层闸门——防进化
 * 退化。批处理调度窗口由使用方驱动（collect_candidates 提供优先级排序），
 * 引擎不内置调度器——调度时机属使用方策略。
 *
 * 迁移差异（TS）：闸门 seam 为结构形态（EvolutionGate，真实 KnowledgeGate
 * 结构上满足——与 knowledge_set.KnowledgeGateLike 同哲学）；frozen dataclass
 * 语义 = readonly + Object.freeze；拒绝留痕中 l1.errors 取 list repr（与
 * knowledge_gate.ts 内部 _list_repr 同口径，python tuple repr 括号差异不落
 * 语义）。
 *
 * 状态标注（机制就绪 / 宿主接线点待定）：EvolutionFactory 为离线变异-
 * 择优工厂，由收敛/批量流程经引擎 API 调用——无回合内自动调度（默认
 * 开关：引擎不内置调度器，入队/择优时机由调用方驱动）。
 */

import { deepCopy } from '../json.js';
import type { Json, JsonRecord } from '../json.js';
import type {
  GateL1Result,
  GateL2Result,
  GateL3Result,
} from '../knowledge_gate/index.js';
import { KnowledgeEntry } from '../knowledge_set/knowledge_entry.js';

// 进化队列优先级权重（失败率优先，长期未调用次之，稳定者殿后）
const _FAILURE_WEIGHT = 10.0;
const _IDLE_WEIGHT = 1.0;

// 变异体数量档位（按失败率/调用频率动态决定）
const _BASE_VARIANTS = 1;
const _MAX_VARIANTS = 3;

// 失败率档位阈值（低于 = 低失败率；高于 = 高失败率）
const _HIGH_FAILURE_RATE = 0.3;
// 长期未调用阈值（usage_count = 0 或远低于调用均值）
const _IDLE_USAGE = 2;

/** 知识闸门 seam：KnowledgeGate.check 的鸭子形态（真实 KnowledgeGate 结构
 *  满足——schema/fixtures/regression 为 unknown 原样透传，领域执行语义由
 *  使用方注入的闸门实现承接；测试以同形假闸门注入，不依赖规则执行器）。 */
export interface EvolutionGate {
  check(
    entry: KnowledgeEntry,
    options: {
      schema?: unknown;
      fixtures?: unknown;
      new_metrics?: Record<string, number> | null;
      old_metrics?: Record<string, number> | null;
      regression?: unknown;
    },
  ): Promise<readonly [GateL1Result, GateL2Result, GateL3Result]>;
}

/** Python list repr 形态（拒绝留痕里错误清单的人类可读呈现——与
 *  knowledge_gate.ts 内部 _list_repr 同口径；python 元组括号差异不落语义）。 */
function _list_repr(items: readonly string[]): string {
  return `[${items.map((item) => `'${item}'`).join(', ')}]`;
}

/** Python round(x, 6) 的数值近似（入口指标 6 位小数定点——比值留痕场景
 *  无银行家舍入歧义，Math.round 逼近即够确定性基线）。 */
function _round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * 进化入队条目（失败率优先排序的依据）。
 */
export class EvolutionCandidate {
  readonly entry: KnowledgeEntry;
  readonly failure_rate: number; // fail_count / usage_count（0-1；无调用 = 0）
  readonly failure_logs: readonly string[]; // 近期失败日志（反思式变异输入）
  readonly is_idle: boolean; // 长期未调用但仍有引用/价值标记

  constructor(init: {
    entry: KnowledgeEntry;
    failure_rate: number;
    failure_logs?: readonly string[];
    is_idle?: boolean;
  }) {
    this.entry = init.entry;
    this.failure_rate = init.failure_rate;
    this.failure_logs = [...(init.failure_logs ?? [])];
    this.is_idle = init.is_idle ?? false;
    Object.freeze(this);
  }

  /** 入队优先级：失败率 × 权重 + 长期未调用 × 权重（数值大优先）。 */
  get priority(): number {
    return (
      this.failure_rate * _FAILURE_WEIGHT +
      (this.is_idle ? _IDLE_WEIGHT : 0.0)
    );
  }
}

/**
 * 一次进化批次的产物（变异体 + 保留/退化判定留痕）。
 */
export class EvolutionOutcome {
  readonly variants: readonly KnowledgeEntry[];
  readonly rejected: readonly string[]; // 未过闸门的变异体说明（防退化留痕）
  readonly gate_results: readonly GateL3Result[];

  constructor(init: {
    variants?: readonly KnowledgeEntry[];
    rejected?: readonly string[];
    gate_results?: readonly GateL3Result[];
  }) {
    this.variants = [...(init.variants ?? [])];
    this.rejected = [...(init.rejected ?? [])];
    this.gate_results = [...(init.gate_results ?? [])];
    Object.freeze(this);
  }

  get kept(): number {
    return this.variants.length;
  }
}

/**
 * 母体知识条目 → L3 维度指标（防退化基线：劣于母体不过 L3）。
 *
 * ENG1-1 修复的指标构造口径（调用留痕 = 该知识的执行观测）：
 * - accuracy = 1 - 失败率（usage_count>0 时按 fail/usage 留痕推算，
 *   成功 = 该知识实际有效运行的证据；从未调用 = 1.0，无失败证据）；
 * - safety = 1.0（闸门 L2 满分基线口径，与 check_l3 默认派生同向）。
 *
 * 不含 latency：条目不携带时序数据（中性基线 1.0 会与变异体真实
 * 测量的 latency<1.0 比较产生虚假「劣化」）——母体无可比时序维度
 * 即不参与比较；变异策略注入 evaluate 时新指标的 latency 也不与
 * 母体比较（母体无该维度数据，口径一致不误判）。
 *
 * 与 MutationStrategy.evaluate 产出的变异体 new_metrics 在 accuracy/safety
 * 维度可比——变异策略注入 evaluate 时「劣于母体不过 L3」按真实评估比较；
 * 未注入时变异体走 L2 默认派生（accuracy 为样例通过率），母体按本口径
 * 给出比较基线。
 */
export function entry_metrics(entry: KnowledgeEntry): Record<string, number> {
  let failure_rate = 0.0;
  if (entry.usage_count > 0) {
    failure_rate = Math.min(entry.fail_count / entry.usage_count, 1.0);
  }
  return {
    accuracy: _round6(1.0 - failure_rate),
    safety: 1.0,
  };
}

/**
 * 变异策略协议：失败日志 → 变异体知识数据（反思式变异的执行体）。
 *
 * 引擎规定「输入失败日志、输出变异体数据」的契约；具体变异操作
 * （结构调整/阈值修订/分支重写）由实现方决定——确定性基线见
 * DeterministicMutation，LLM 反思变异为可选扩展。
 *
 * evaluate 为可选钩子：变异体的维度指标评估（L3 目标筛选的 new_metrics
 * 来源；返回 null = 用 L2 样例派生默认）——不实现时进化工厂按默认指标
 * 口径走 L3。
 */
export interface MutationStrategy {
  mutate(
    entry: KnowledgeEntry,
    failure_logs: readonly string[],
  ): readonly JsonRecord[];

  /** 变异体维度指标（accuracy/latency/safety…）；null = 默认口径。 */
  evaluate?(
    variant_data: JsonRecord,
    schema: unknown,
    fixtures: unknown,
  ): Promise<Record<string, number> | null>;
}

/**
 * 确定性变异基线：按失败日志局部修订（零 LLM，可测试可断言）。
 *
 * 变异语义（防退化底线：变异体必须过三层闸门才保留）：
 * - 每次变异 = 一条可解释的结构化修订（修订原因 = 失败日志摘要）；
 * - 多日志分别变异（每条失败日志产出一个变体候选——失败驱动的
 *   定向探索），受调用频率/失败次数动态数量上限约束；
 * - 变异体与母体共享 id 前缀（同一知识的不同版本，随补丁链分支）。
 */
export class DeterministicMutation implements MutationStrategy {
  readonly max_variants: number;

  constructor(max_variants: number = _MAX_VARIANTS) {
    this.max_variants = max_variants;
  }

  /** 变异体数量：按失败率/调用频率动态决定（高活跃多探索）。
   *
   * 上限取实例配置（子类覆写构造不继承时回落模块缺省）。 */
  variant_count(candidate: EvolutionCandidate): number {
    const limit = this.max_variants ?? _MAX_VARIANTS;
    if (candidate.failure_rate >= _HIGH_FAILURE_RATE) {
      return Math.min(limit, Math.max(_BASE_VARIANTS, candidate.failure_logs.length));
    }
    return _BASE_VARIANTS;
  }

  /** 失败日志 → 变异体数据清单（每条日志一个定向修订变体）。
   *
   * Returns:
   *     变异体 data 清单（与母体 data 同构，修订原因入 note 字段）；
   *     空 = 无失败日志（无从反思，不产出无依据变异）。 */
  mutate(
    entry: KnowledgeEntry,
    failure_logs: readonly string[],
  ): JsonRecord[] {
    if (failure_logs.length === 0) {
      return [];
    }
    const limit = this.max_variants ?? _MAX_VARIANTS;
    const variants: JsonRecord[] = [];
    for (const log of failure_logs.slice(0, limit)) {
      // 深拷贝：嵌套结构共享引用会污染母体条目（ENG1-10）——变异体
      // 只在其自身 data 上追加修订标记，母体 data 永不被改写
      const variant = deepCopy(entry.data as Json) as JsonRecord;
      variant['_mutation'] = {
        based_on: log,
        variant_of: entry.id,
      };
      variants.push(variant);
    }
    return variants;
  }
}

/**
 * 进化工厂：失败率优先入队 → 反思式变异 → 三层闸门防退化。
 *
 * 使用流程（使用方驱动调度窗口）：
 * 1. 收集候选（collect_candidates 或使用方自建候选清单）；
 * 2. 按优先级排序（rank）；
 * 3. 逐候选进化（evolve）——变异体过闸门（L1/L2/L3），L3 是防退化底线
 *    （不差于旧版才保留）。
 */
export class EvolutionFactory {
  readonly gate: EvolutionGate;
  readonly mutation: MutationStrategy;

  constructor(gate: EvolutionGate, mutation: MutationStrategy | null = null) {
    this.gate = gate;
    this.mutation = mutation ?? new DeterministicMutation();
  }

  /** 候选收集：失败率优先入队（次之长期未调用，稳定者不入队）。
   *
   * @param entries 知识集条目（工作/项目/用户级全部）。
   * @param failure_logs 条目 id → 近期失败日志（反思式变异输入）。
   * @param idle_threshold 长期未调用判定阈值（usage_count ≤ 该值）。
   * @returns 按优先级降序的候选清单（稳定且活跃的条目不参与进化）。
   */
  static collect_candidates(
    entries: readonly KnowledgeEntry[],
    options: {
      failure_logs?: Readonly<Record<string, readonly string[]>> | null;
      idle_threshold?: number;
    } = {},
  ): EvolutionCandidate[] {
    const logs = options.failure_logs ?? {};
    const idleThreshold = options.idle_threshold ?? _IDLE_USAGE;
    const candidates: EvolutionCandidate[] = [];
    for (const entry of entries) {
      if (entry.usage_count <= 0) {
        continue; // 从未调用：无从评估失败率，也不进化（避免噪音）
      }
      const failureRate = Math.min(entry.fail_count / entry.usage_count, 1.0);
      const idle = entry.usage_count <= idleThreshold && entry.credibility > 0;
      if (failureRate <= 0.0 && !idle) {
        // 稳定高频零失败：不参与进化（与「失败率优先、次之长期未调用、
        // 稳定者不入队」文档一致——ENG1-3：旧实现把稳定条目也入队，与
        // docstring「稳定且活跃的条目不参与进化」矛盾）
        continue;
      }
      candidates.push(
        new EvolutionCandidate({
          entry,
          failure_rate: failureRate,
          failure_logs: logs[entry.id] ?? [],
          is_idle: idle,
        }),
      );
    }
    return candidates;
  }

  /** 入队排序：优先级降序（失败率优先，稳定者殿后）。 */
  static rank(
    candidates: readonly EvolutionCandidate[],
  ): EvolutionCandidate[] {
    return [...candidates].sort((a, b) => b.priority - a.priority);
  }

  /** 进化单个候选：反思式变异 → 逐变体过闸门 → 保留不退化者。
   *
   * @param candidate 进化候选（含失败日志——反思式变异输入）。
   * @param schema L1 schema 声明（变异体形式合法关）。
   * @param fixtures L2 完整样例库（变异体效果关，非谈判项）。
   * @param old_metrics 母体维度指标（L3 目标筛选基准——不差于旧版）。
   * @param regression L2 历史回归用例（追加评估；None = 不追加）。
   * @returns EvolutionOutcome：保留的变异体（已过三层闸门）+ 拒绝留痕
   *          （防退化：L3 拒绝 = 劣于旧版，不落库）。
   */
  async evolve(
    candidate: EvolutionCandidate,
    options: {
      schema: unknown;
      fixtures: unknown;
      old_metrics?: Record<string, number> | null;
      regression?: unknown;
    },
  ): Promise<EvolutionOutcome> {
    if (candidate.failure_logs.length === 0) {
      // 区分「稳定无日志」与「真无日志」（ENG1-22）：失败率 = 0 的候选是
      // 稳定条目（无失败可记），有失败率却无日志 = 留痕缺口（失败发生了
      // 但日志没采到）——两种情形拒绝文案不同，观察侧可据此识别留痕链路
      // 问题
      const reason =
        candidate.failure_rate <= 0.0
          ? '无失败日志（稳定条目无失败可反思）'
          : '无失败日志（有失败率但日志缺失，无从反思）';
      return new EvolutionOutcome({ rejected: [`${candidate.entry.id}: ${reason}`] });
    }
    const oldMetrics =
      options.old_metrics ?? entry_metrics(candidate.entry);
    // 变异体数量按失败率/调用频率动态决定（高活跃多探索，低活跃单变体
    // 控膨胀）：策略实现 variant_count 时以其为准，否则全量日志
    const strategy = this.mutation as MutationStrategy & {
      variant_count?: (c: EvolutionCandidate) => number;
    };
    const variantLimit =
      typeof strategy.variant_count === 'function'
        ? strategy.variant_count(candidate)
        : candidate.failure_logs.length;
    const failureLogs = candidate.failure_logs.slice(0, variantLimit);
    const variants: KnowledgeEntry[] = [];
    const rejected: string[] = [];
    const gateResults: GateL3Result[] = [];
    const evaluator = this.mutation.evaluate ?? null;
    for (const raw of this.mutation.mutate(candidate.entry, failureLogs)) {
      const variant = new KnowledgeEntry({
        id: `${candidate.entry.id}:v${variants.length + 1}`,
        level: candidate.entry.level,
        kind: candidate.entry.kind,
        data: raw,
        source: candidate.entry.source,
        credibility: candidate.entry.credibility,
        title: `${candidate.entry.title}（变异）`,
        tags: candidate.entry.tags,
      });
      let newMetrics: Record<string, number> | null = null;
      if (evaluator !== null) {
        try {
          newMetrics = await evaluator(raw, options.schema, options.fixtures);
        } catch {
          newMetrics = null; // 评估钩子异常 = 回落默认口径
        }
      }
      const [l1, l2, l3] = await this.gate.check(variant, {
        schema: options.schema,
        fixtures: options.fixtures,
        new_metrics: newMetrics,
        old_metrics: oldMetrics,
        regression: options.regression,
      });
      gateResults.push(l3);
      if (l1.passed && l2.passed && l3.passed) {
        variants.push(variant);
      } else {
        const failedAt = !l1.passed ? 'L1' : !l2.passed ? 'L2' : 'L3';
        const detail = l3.reason || l2.note || _list_repr(l1.errors);
        rejected.push(`${variant.id}: ${failedAt} 未通过（${detail}）`);
      }
    }
    return new EvolutionOutcome({
      variants,
      rejected,
      gate_results: gateResults,
    });
  }
}
