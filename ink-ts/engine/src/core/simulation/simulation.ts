/**
 * 决策点推演原语的数据面（``__simulate__`` 保留键 / 分支规格 / 评估协议 / 择优调配）。
 *
 * 推演-回溯-换选机制的引擎形态：关键决策点节点返回推演清单，引擎把每个
 * 分支作为独立子链执行（与 spawn 同构：分支入口状态自包含 + 独立 checkpoint
 * 链，落选分支不销毁——保留为轨迹树引用，可回溯对比/换选，经 Engine.swap_branch
 * 重放改选），执行结果经评估协议（Evaluator）打分，再由调配策略（BranchMixer）
 * 择优提交主线——单选或跨分支组装（分支 A 的一部分 + 分支 B 的另一部分），
 * 组装留痕记录「哪部分来自哪个分支」。
 *
 * 数据形态（节点返回值携带 ``__simulate__`` 保留键）：
 *     {
 *         "step_id": "step-123",      // 可选：决策点步骤 id（分支事件 parent_step_id）
 *         "budget": 4000,             // 可选：主线上下文组装预算（传给调配策略）
 *         "branches": [
 *             {"subgraph": <Graph|图定义数据>, "state": {...}, "index": 0,
 *              "description": "分支说明"},
 *             ...
 *         ]
 *     }
 *
 * 评估协议在引擎（core），评审策略在用户集（规则集/加权打分器）——引擎
 * 只规定「评估产出什么」，不规定「怎么评」。
 */

import { GraphDefinitionError } from '../errors.js';
import { Graph } from '../graph/graph.js';
import { deepCopy, isRecord, type Json, type JsonRecord } from '../json.js';
import { Patch, PatchChain, PatchOp } from '../patch/patchChain.js';
import { DimensionScore } from '../scoring/scoring.js';
import { SimulateSpec, Evaluation, EvaluatedBranch, ProvenanceNote, BranchSelection, type Evaluator, type BranchMixer, type DimensionScorer } from './simulation_types.js';

export { SimulateSpec, Evaluation, EvaluatedBranch, ProvenanceNote, BranchSelection } from './simulation_types.js';
export type { Evaluator, BranchMixer, DimensionScorer } from './simulation_types.js';

// 数据驱动形态的保留键：节点返回值携带此键 = 推演分支清单（引擎内部
// 消费，不落状态通道）；与 __spawn__/__plan__ 同属引擎保留命名空间。
export const SIMULATE_KEY = '__simulate__';

// 清单信封的键名
const _BRANCHES_KEY = 'branches';
const _STEP_ID_KEY = 'step_id';
const _BUDGET_KEY = 'budget';

// 缺省推演分支数上限（成本护栏：分支推演是完整子链执行，清单超限
// 即节点失败，防推演爆炸）
export const DEFAULT_MAX_SIMULATIONS = 8;

// ── 评估器桥接 / 调配策略 ──────────────────────────────────────────────────

/** 加权打分器 → 评估协议的桥接参考实现（机制接入，策略在使用方）。 */
export class WeightedScorerEvaluator {
  readonly #scorer: { score: (dimensions: Record<string, number>) => { total: number; passed: boolean; failing_dimensions: readonly { name: string }[]; scores: readonly { name: string; score: number; note: string }[] } };
  readonly dimension_scorer: DimensionScorer | null;
  readonly rule_version: string | null;
  readonly params_snapshot: Record<string, unknown> | null;

  constructor(
    config: unknown,
    options: {
      dimension_scorer?: DimensionScorer | null;
      rule_version?: string | null;
      params_snapshot?: Record<string, unknown> | null;
    } = {},
  ) {
    this.#scorer = config as { score: (dimensions: Record<string, number>) => { total: number; passed: boolean; failing_dimensions: readonly { name: string }[]; scores: readonly { name: string; score: number; note: string }[] } };
    this.dimension_scorer = options.dimension_scorer ?? null;
    this.rule_version = options.rule_version ?? null;
    this.params_snapshot = options.params_snapshot ?? null;
  }

  async evaluate(branch: SimulateSpec, overlay: Record<string, unknown>): Promise<Evaluation> {
    const dimensions = this.dimension_scorer !== null
      ? this.dimension_scorer(branch, overlay)
      : {};
    const result = this.#scorer.score(dimensions);
    const note = '加权打分器桥接评估' +
      (result.failing_dimensions.length > 0
        ? `; 未达标维度: [${result.failing_dimensions.map((d) => d.name).join(', ')}]`
        : '');
    const dims = result.scores.map((s) => new DimensionScore(s.name, s.score, s.note));
    return new Evaluation({
      score: result.total,
      passed: result.passed && result.failing_dimensions.length === 0,
      note,
      dimensions: dims,
      rule_version: this.rule_version,
      params_snapshot: this.params_snapshot,
    });
  }
}

// ── 提交增量裁剪 ──────────────────────────────────────────────────────────

/**
 * 提交增量按预算裁剪（序列化字符上界；null/非正 = 不裁剪）。
 *
 * 确定性：按键序依次纳入，字符串值超预算截断到剩余预算（文本是状态通道的
 * 常见形态），非字符串形态整键纳入；首个键至少保留（提交非空）。预算 =
 * 主线上下文可容纳的增量上限，留痕记裁剪后实际提交内容。
 */
export function fit_overlay(overlay: Record<string, unknown>, budget: number | null | undefined): Record<string, unknown> {
  if (budget === null || budget === undefined || budget <= 0) {
    return JSON.parse(JSON.stringify(overlay));
  }

  const kept: Record<string, unknown> = {};
  let used = 0;
  let first = true;
  for (const [key, value] of Object.entries(overlay)) {
    if (typeof value === 'string') {
      const size = value.length;
      if (first && used + size > budget) {
        kept[key] = value.slice(0, budget - used);
        break;
      }
      if (used + size > budget) {
        kept[key] = value.slice(0, budget - used);
        break;
      }
      kept[key] = value;
      used += size;
      first = false;
      continue;
    }
    const size = JSON.stringify(value).length;
    if (!first && used + size > budget) break;
    kept[key] = value;
    used += size;
    first = false;
  }
  return kept;
}

// ── 调配策略 ──────────────────────────────────────────────────────────────

/** 默认调配策略：通过评估的分支中取最高分整体提交（确定性单选）。 */
export class BestBranchMixer {
  async mix(branches: readonly EvaluatedBranch[], options?: { budget?: number | null }): Promise<BranchSelection> {
    const candidates = branches.filter((b) => b.evaluation.passed);
    if (candidates.length === 0) {
      throw new GraphDefinitionError('无可提交的推演分支（全部未通过评估）');
    }
    let bestBranch = candidates[0]!;
    for (const candidate of candidates) {
      const diff = candidate.evaluation.score - bestBranch.evaluation.score;
      if (diff > 0 || (diff === 0 && candidate.spec.index < bestBranch.spec.index)) {
        bestBranch = candidate;
      }
    }
    const overlay = fit_overlay(bestBranch.overlay, options?.budget ?? null);
    const provenance = Object.keys(overlay).length > 0
      ? [new ProvenanceNote({ branch_index: bestBranch.spec.index, key: '*', note: '整体提交' })]
      : [];
    return new BranchSelection({
      selected: [bestBranch.spec.index],
      overlay,
      provenance,
    });
  }
}

/** 跨分支组装参考实现（补丁链 assemble 复用，来源留痕可审计）。 */
export class PatchChainBranchMixer {
  async mix(branches: readonly EvaluatedBranch[], options?: { budget?: number | null }): Promise<BranchSelection> {
    const selected: number[] = [];
    const provenance: { branch_index: number; key: string; note: string }[] = [];
    const chain = new PatchChain({}, []);
    // 按评估分降序（平分按序号升序）填充：高分分支的键先落位，后续
    // 分支只补空缺——同键冲突由高分分支胜出（策略明确，可断言）
    const ordered = [...branches].sort((a, b) => {
      const diff = b.evaluation.score - a.evaluation.score;
      if (diff !== 0) return diff;
      return a.spec.index - b.spec.index;
    });
    const filled = new Set<string>();
    for (const evaluated of ordered) {
      const overlay = evaluated.overlay;
      if (Object.keys(overlay).length === 0) continue;
      selected.push(evaluated.spec.index);
      for (const [key, value] of Object.entries(overlay)) {
        if (filled.has(key)) continue;
        filled.add(key);
        chain.apply({ op: 'replace', path: [key], value: value as Json });
        provenance.push({
          branch_index: evaluated.spec.index,
          key,
          note: '跨分支组装（补丁链）',
        });
      }
    }
    if (selected.length === 0) {
      throw new GraphDefinitionError('无可提交的推演分支（全部 overlay 为空）');
    }
    const assembled = chain.assemble();
    return new BranchSelection({
      selected,
      overlay: fit_overlay(assembled, options?.budget ?? null),
      provenance: provenance.map((p) => new ProvenanceNote(p)),
    });
  }
}

// ── 推演收口结果 ──────────────────────────────────────────────────────────

/** 一次决策点推演的收口结果（择优提交 + 全分支留痕）。 */
export class SimulationResult {
  readonly selection: BranchSelection;
  readonly branches: readonly EvaluatedBranch[];
  readonly thread_ids: Record<number, string>;

  constructor(init: {
    selection: BranchSelection;
    branches?: readonly EvaluatedBranch[];
    thread_ids?: Record<number, string>;
  }) {
    this.selection = init.selection;
    this.branches = init.branches ?? [];
    this.thread_ids = init.thread_ids ?? {};
    Object.freeze(this);
  }
}

// ── 清单解析 ──────────────────────────────────────────────────────────────

interface ParseSimulateOptions {
  resolve_graph?: ((data: Record<string, unknown>) => SimulateSpec['subgraph']) | null;
  max_branches?: number;
}

/**
 * 解析并校验节点返回的推演清单（建期即拒绝，不延后到执行期）。
 *
 * @param data ``__simulate__`` 键的值（{"branches": [...], ...} 信封形态）。
 * @param options.resolve_graph 图定义数据 → Graph 解析器（分支子图数据形态重建；
 *     Graph 实例直通）。
 * @param options.max_branches 分支数上限（成本护栏；0 = 禁用推演）。
 * @returns [step_id, budget, branches]：决策点步骤 id（可选）、主线组装预算
 *     （可选）、解析校验后的分支清单。
 */
export function parse_simulate(
  data: unknown,
  options: ParseSimulateOptions = {},
): [string | null, number | null, SimulateSpec[]] {
  const { resolve_graph = null, max_branches = DEFAULT_MAX_SIMULATIONS } = options;

  if (max_branches <= 0) {
    throw new GraphDefinitionError('推演已禁用（max_simulations=0）');
  }
  if (!isRecord(data) || !Array.isArray((data as JsonRecord)[_BRANCHES_KEY])) {
    throw new GraphDefinitionError(
      `推演清单须为 {branches: [...]} 信封形态: ${typeof data}`,
    );
  }
  const record = data as JsonRecord;
  const step_id = record[_STEP_ID_KEY];
  if (step_id !== null && step_id !== undefined && typeof step_id !== 'string') {
    throw new GraphDefinitionError(`推演决策点 step_id 须为字符串: ${String(step_id)}`);
  }
  const budget_raw = record[_BUDGET_KEY];
  let budget: number | null = null;
  if (budget_raw !== null && budget_raw !== undefined) {
    const num = Number(budget_raw);
    if (!Number.isFinite(num)) {
      throw new GraphDefinitionError(`推演组装预算非法: ${String(budget_raw)}`);
    }
    budget = Math.trunc(num);
    if (budget <= 0) {
      throw new GraphDefinitionError(`推演组装预算必须为正: ${budget}`);
    }
  }
  const raw_branches = (record[_BRANCHES_KEY] as unknown[]) ?? [];
  if (raw_branches.length === 0) {
    throw new GraphDefinitionError('推演分支清单为空（至少一个分支）');
  }
  if (raw_branches.length > max_branches) {
    throw new GraphDefinitionError(`推演分支超限: ${raw_branches.length} > ${max_branches}`);
  }
  const branches: SimulateSpec[] = [];
  for (let i = 0; i < raw_branches.length; i++) {
    const raw = raw_branches[i]!;
    if (!isRecord(raw)) {
      throw new GraphDefinitionError(`推演第 ${i} 项分支声明非法: 期望 dict`);
    }
    const rawRecord = raw as JsonRecord;
    const subgraph = rawRecord['subgraph'];
    let resolved_subgraph: SimulateSpec['subgraph'];
    if (subgraph instanceof Graph) {
      resolved_subgraph = subgraph;
    } else if (isRecord(subgraph) && resolve_graph !== null) {
      resolved_subgraph = resolve_graph(subgraph as Record<string, unknown>);
      if (!(resolved_subgraph instanceof Graph)) {
        throw new GraphDefinitionError('推演分支解析器须返回 Graph 实例');
      }
    } else {
      const hint = isRecord(subgraph) ? '，需注入解析器' : '';
      throw new GraphDefinitionError(
        `推演第 ${i} 项缺子图实例（Graph 或图定义数据${hint}）`,
      );
    }
    let state = rawRecord['state'];
    if (!isRecord(state)) {
      if (state !== null && state !== undefined) {
        throw new GraphDefinitionError(`推演第 ${i} 项状态须为 dict`);
      }
      state = {} as JsonRecord;
    }
    const raw_index = rawRecord['index'];
    let index: number;
    if (raw_index === null || raw_index === undefined) {
      index = branches.length;
    } else {
      const num = Number(raw_index);
      if (!Number.isFinite(num)) {
        throw new GraphDefinitionError(`推演第 ${i} 项序号非法: ${String(raw_index)}`);
      }
      index = Math.trunc(num);
    }
    const description = rawRecord['description'];
    if (description !== null && description !== undefined && typeof description !== 'string') {
      throw new GraphDefinitionError(`推演第 ${i} 项说明须为字符串: ${String(description)}`);
    }
    branches.push(new SimulateSpec({
      subgraph: resolved_subgraph,
      state: JSON.parse(JSON.stringify(state)) as Record<string, unknown>,
      index,
      description: typeof description === 'string' ? description : '',
    }));
  }
  const indexes = branches.map((b) => b.index);
  if (new Set(indexes).size !== indexes.length) {
    throw new GraphDefinitionError(`推演分支序号重复: ${[...indexes].sort((a, b) => a - b)}`);
  }
  return [step_id ?? null, budget, branches];
}

/**
 * 分支独立子链归属：``{父thread}:simulate:{index}``（可回溯/换选定位）。
 */
export function simulate_thread_id(parent_thread: string, index: number): string {
  return `${parent_thread}:simulate:${index}`;
}
