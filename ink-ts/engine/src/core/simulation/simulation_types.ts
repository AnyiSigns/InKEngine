/**
 * 决策点推演原语的数据面类型（分支规格 / 评估结果 / 调配结果 / 协议）。
 */

import type { Json, JsonRecord } from '../json.js';
import { Graph } from '../graph/graph.js';
import { DimensionScore } from '../scoring/scoring.js';
import { GraphDefinitionError } from '../errors.js';

// ── 分支规格 / 评估结果 / 调配结果数据形态 ────────────────────────────────

/** 推演分支规格：子图 + 自包含入口状态 + 分支序号 + 说明。 */
export class SimulateSpec {
  readonly subgraph: Graph;
  readonly state: Record<string, unknown>;
  readonly index: number;
  readonly description: string;

  constructor(init: { subgraph: Graph; state: Record<string, unknown>; index: number; description?: string }) {
    this.subgraph = init.subgraph;
    this.state = init.state;
    this.index = init.index;
    this.description = init.description ?? '';
    Object.freeze(this);
  }

  to_dict(): Record<string, unknown> {
    return {
      index: this.index,
      description: this.description,
      subgraph: this.subgraph.to_dict(),
      state: JSON.parse(JSON.stringify(this.state)),
    };
  }

  static from_dict(data: unknown, options: { resolve_graph?: ((data: Record<string, unknown>) => Graph) | null } = {}): SimulateSpec {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new GraphDefinitionError(`推演分支声明非法: 期望 dict，收到 ${typeof data}`);
    }
    const record = data as Record<string, unknown>;
    const index = Number(record['index'] ?? 0);
    if (!Number.isFinite(index)) {
      throw new GraphDefinitionError(`推演分支序号非法: ${String(record['index'])}`);
    }
    const description = record['description'] ?? '';
    if (description !== '' && typeof description !== 'string') {
      throw new GraphDefinitionError(`推演分支说明须为字符串: ${String(description)}`);
    }
    const subgraph = record['subgraph'];
    let resolved: Graph;
    if (subgraph instanceof Graph) {
      resolved = subgraph;
    } else if (subgraph && typeof subgraph === 'object' && options.resolve_graph !== null && options.resolve_graph !== undefined) {
      resolved = options.resolve_graph(subgraph as Record<string, unknown>);
      if (!(resolved instanceof Graph)) {
        throw new GraphDefinitionError('推演分支解析器须返回 Graph 实例');
      }
    } else {
      const hint = subgraph && typeof subgraph === 'object' ? '，需注入解析器' : '';
      throw new GraphDefinitionError(`推演分支快照缺子图实例（Graph 或图定义数据${hint}）`);
    }
    const state = record['state'];
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new GraphDefinitionError('推演分支快照的状态须为 dict');
    }
    return new SimulateSpec({
      subgraph: resolved,
      state: JSON.parse(JSON.stringify(state)) as Record<string, unknown>,
      index: Math.trunc(index),
      description: typeof description === 'string' ? description : '',
    });
  }
}

/** 分支评估结果（Evaluator 协议产出：分数 + 是否通过 + 说明 + 维度明细）。 */
export class Evaluation {
  readonly score: number;
  readonly passed: boolean;
  readonly note: string;
  readonly dimensions: readonly DimensionScore[];
  readonly rule_version: string | null;
  readonly params_snapshot: Record<string, unknown> | null;

  constructor(init: {
    score?: number;
    passed?: boolean;
    note?: string;
    dimensions?: readonly DimensionScore[];
    rule_version?: string | null;
    params_snapshot?: Record<string, unknown> | null;
  } = {}) {
    this.score = init.score ?? 0;
    this.passed = init.passed ?? true;
    this.note = init.note ?? '';
    this.dimensions = init.dimensions ?? [];
    this.rule_version = init.rule_version ?? null;
    this.params_snapshot = init.params_snapshot ?? null;
    Object.freeze(this);
    if (this.params_snapshot !== null) Object.freeze(this.params_snapshot);
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      score: this.score,
      passed: this.passed,
    };
    if (this.note) data['note'] = this.note;
    if (this.dimensions.length > 0) {
      data['dimensions'] = this.dimensions.map((d) => ({
        name: d.name,
        score: d.score,
        note: d.note,
      }));
    }
    if (this.rule_version !== null) data['rule_version'] = this.rule_version;
    if (this.params_snapshot !== null) data['params_snapshot'] = JSON.parse(JSON.stringify(this.params_snapshot));
    return data;
  }

  static from_dict(data: unknown): Evaluation {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new GraphDefinitionError(`评估结果声明非法: 期望 dict，收到 ${typeof data}`);
    }
    const record = data as Record<string, unknown>;
    const raw_dims = record['dimensions'];
    const dimensions: DimensionScore[] = Array.isArray(raw_dims)
      ? raw_dims.map((raw) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GraphDefinitionError('评估维度须为 dict');
          const r = raw as Record<string, unknown>;
          return new DimensionScore(String(r['name'] ?? ''), Number(r['score'] ?? 0), String(r['note'] ?? ''));
        })
      : [];
    const snapshot = record['params_snapshot'];
    return new Evaluation({
      score: Number(record['score'] ?? 0),
      passed: Boolean(record['passed'] ?? true),
      note: String(record['note'] ?? ''),
      dimensions,
      rule_version: (record['rule_version'] ?? null) as string | null,
      params_snapshot: snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown> : null,
    });
  }
}

/** 已完成评估的分支（分支规格 + 执行回流增量 + 评估结果）。 */
export class EvaluatedBranch {
  readonly spec: SimulateSpec;
  readonly overlay: Record<string, unknown>;
  readonly evaluation: Evaluation;

  constructor(init: { spec: SimulateSpec; overlay: Record<string, unknown>; evaluation: Evaluation }) {
    this.spec = init.spec;
    this.overlay = init.overlay;
    this.evaluation = init.evaluation;
    Object.freeze(this);
    Object.freeze(this.overlay);
  }

  to_dict(): Record<string, unknown> {
    return {
      spec: this.spec.to_dict(),
      overlay: { ...this.overlay },
      evaluation: this.evaluation.to_dict(),
    };
  }
}

/** 组装来源留痕：主线增量中「哪段来自哪个分支」（逐源留痕，可审计）。 */
export class ProvenanceNote {
  readonly branch_index: number;
  readonly key: string;
  readonly note: string;

  constructor(init: { branch_index: number; key: string; note?: string }) {
    this.branch_index = init.branch_index;
    this.key = init.key;
    this.note = init.note ?? '';
    Object.freeze(this);
  }
}

/** 择优结果：选中分支 + 提交主线的组装增量 + 来源留痕。 */
export class BranchSelection {
  readonly selected: readonly number[];
  readonly overlay: Record<string, unknown>;
  readonly provenance: readonly ProvenanceNote[];

  constructor(init: {
    selected: readonly number[];
    overlay: Record<string, unknown>;
    provenance?: readonly ProvenanceNote[];
  }) {
    this.selected = init.selected;
    this.overlay = init.overlay;
    this.provenance = init.provenance ?? [];
    Object.freeze(this);
    Object.freeze(this.overlay);
  }
}

// ── 协议 / 钩子类型 ────────────────────────────────────────────────────────

/** 分支评估器协议（引擎通用机制；评审策略由用户集注入）。 */
export interface Evaluator {
  evaluate(branch: SimulateSpec, overlay: Record<string, unknown>): Promise<Evaluation>;
}

/** 分支结果调配策略（调配器思想：多源汇入单流）。 */
export interface BranchMixer {
  mix(branches: readonly EvaluatedBranch[], options?: { budget?: number | null }): Promise<BranchSelection>;
}

/** 维度评分钩子：分支规格 + 回流增量 → 维度得分表（0-1，领域语义）。 */
export type DimensionScorer = (branch: SimulateSpec, overlay: Record<string, unknown>) => Record<string, number>;
