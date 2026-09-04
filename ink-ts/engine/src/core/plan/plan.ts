/**
 * 运行时重规划原语的数据面（__plan__ 保留键 / 计划清单模型 / 解析校验）。
 *
 * 图拓扑随状态演化：节点返回下一跳计划清单（顺序节点组/并行组/条件门/
 * spawn 子图实例项），引擎按清单续跑、执行一段后再规划——拓扑成为可改写
 * 的数据，而非编译期固定。与 __spawn__ 的关系：计划 = 流的结构
 * （下一跳编排），spawn = 流的展开（并行子图实例），两者可嵌套（计划
 * 步骤可携带 spawn 清单，展开共用执行器的实例展开路径）。
 *
 * 计划版本化（硬性要求）：计划是 checkpoint 快照字段（随版本链落盘与
 * 回滚）——回溯决策点时计划与状态一起回到当时版本，保证后续推演/换选
 * 的锚点语义。因此本模块全部模型为纯数据（可 JSON 序列化）：节点/条件
 * 以注册名引用，spawn 子图以图定义数据形态携带（Graph 对象在入计划前
 * 序列化为数据，函数不是数据）。
 *
 * 工作流约束域：计划引用的节点必须存在于当前图（计划落在「可执行的
 * 计划空间」内）；宽松域 = 任意已注册节点，严格序 = 每一步节点须与
 * 上一步存在图边关联（策略由 RunOptions.plan_policy 配置）。
 */

import { GraphDefinitionError } from '../errors.js';
import { Graph } from '../graph/graph.js';
import type { EdgeConditionRegistryLike } from '../graph/graph_types.js';
import { isRecord, typeName } from '../json.js';
import { WorkflowEdgeSpec, WorkflowNodeSpec, WorkflowSpec } from '../workflow/workflow_types.js';

export const PLAN_KEY = '__plan__';

export const KIND_NODES = 'nodes';
export const KIND_PARALLEL = 'parallel';
export const KIND_SPAWNS = 'spawns';

const STEPS_KEY = 'steps';
const INDEX_KEY = 'index';

export const DEFAULT_MAX_PLAN_STEPS = 32;

function requireExactlyOneKind(data: Record<string, unknown>): string {
  const present = [KIND_NODES, KIND_PARALLEL, KIND_SPAWNS].filter((k) => k in data);
  if (present.length !== 1) {
    throw new GraphDefinitionError(
      `计划步骤须恰好声明 nodes/parallel/spawns 之一，实际: ${present.length === 0 ? '无' : present.join(', ')}`,
    );
  }
  return present[0]!;
}

function isGraphLike(value: unknown): value is { to_dict(): unknown } {
  return isRecord(value) && typeof (value as Record<string, unknown>).to_dict === 'function';
}

export class PlanStep {
  readonly kind: string;
  readonly nodes: readonly string[];
  readonly spawns: readonly Record<string, unknown>[];
  readonly condition: string | null;

  constructor(init: {
    kind: string;
    nodes?: readonly string[];
    spawns?: readonly Record<string, unknown>[];
    condition?: string | null;
  }) {
    this.kind = init.kind;
    this.nodes = init.nodes ? [...init.nodes] : [];
    this.spawns = init.spawns ? [...init.spawns] : [];
    this.condition = init.condition ?? null;
    Object.freeze(this.nodes);
    Object.freeze(this.spawns);
    Object.freeze(this);
  }

  toDict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      [this.kind]: this.nodes.length > 0 ? [...this.nodes] : [],
    };
    if (this.kind === KIND_SPAWNS) {
      const spawns: Record<string, unknown>[] = [];
      for (const item of this.spawns) {
        const entry = { ...item };
        if (isGraphLike(entry.subgraph)) {
          entry.subgraph = entry.subgraph.to_dict();
        }
        spawns.push(entry);
      }
      data[KIND_SPAWNS] = spawns;
    }
    if (this.condition !== null) {
      data.condition = this.condition;
    }
    return data;
  }

  static fromDict(data: Record<string, unknown>): PlanStep {
    const kind = requireExactlyOneKind(data);
    const condition = data.condition;
    if (condition !== null && condition !== undefined && typeof condition !== 'string') {
      throw new GraphDefinitionError(`计划步骤条件名须为字符串: ${JSON.stringify(condition)}`);
    }
    if (kind === KIND_SPAWNS) {
      const spawns = data[KIND_SPAWNS];
      if (!Array.isArray(spawns) || !spawns.every((item) => isRecord(item))) {
        throw new GraphDefinitionError('计划 spawn 步骤须携带 [{subgraph, state, index}, ...] 清单');
      }
      return new PlanStep({ kind, spawns, condition });
    }
    const names = data[kind];
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
      throw new GraphDefinitionError(`计划步骤 ${kind} 须为节点名列表`);
    }
    if (names.length === 0) {
      throw new GraphDefinitionError(`计划步骤 ${kind} 为空（无节点可执行）`);
    }
    return new PlanStep({ kind, nodes: names, condition });
  }
}

export class Plan {
  readonly steps: readonly PlanStep[];
  readonly index: number;

  constructor(init: { steps?: readonly PlanStep[]; index?: number }) {
    this.steps = init.steps ? [...init.steps] : [];
    this.index = init.index ?? 0;
    Object.freeze(this.steps);
    Object.freeze(this);
  }

  get remaining(): readonly PlanStep[] {
    return this.steps.slice(this.index);
  }

  toDict(): Record<string, unknown> {
    return {
      [STEPS_KEY]: this.steps.map((s) => s.toDict()),
      [INDEX_KEY]: this.index,
    };
  }

  static fromDict(data: Record<string, unknown>): Plan {
    const rawSteps = data[STEPS_KEY];
    if (!Array.isArray(rawSteps)) {
      throw new GraphDefinitionError('计划快照缺 steps 清单');
    }
    const index = typeof data[INDEX_KEY] === 'number' ? data[INDEX_KEY] : 0;
    const steps = rawSteps.map((step) => PlanStep.fromDict(step as Record<string, unknown>));
    if (index < 0 || index > steps.length) {
      throw new GraphDefinitionError(`计划游标越界: ${index}（共 ${steps.length} 步）`);
    }
    return new Plan({ steps, index });
  }

  static parse(
    data: unknown,
    opts: {
      graph: Graph;
      edge_registry?: EdgeConditionRegistryLike | null;
      policy?: string;
      max_steps?: number;
      workflow?: WorkflowSpec | null;
    },
  ): Plan {
    const {
      graph,
      edge_registry = null,
      policy = 'loose',
      max_steps = DEFAULT_MAX_PLAN_STEPS,
      workflow = null,
    } = opts;

    let raw = data;
    if (isRecord(raw) && STEPS_KEY in raw) {
      raw = (raw as Record<string, unknown>)[STEPS_KEY];
    }
    if (!Array.isArray(raw)) {
      throw new GraphDefinitionError(
        `计划清单须为步骤列表或 {steps: [...]} 信封: ${typeName(raw)}`,
      );
    }
    if (raw.length === 0) {
      throw new GraphDefinitionError('计划清单为空（无下一步编排）');
    }
    if (max_steps > 0 && raw.length > max_steps) {
      throw new GraphDefinitionError(`计划步数超限: ${raw.length} > ${max_steps}`);
    }

    const workflowNodeIds =
      workflow !== null ? new Set(workflow.nodes.map((n) => n.id)) : null;

    const steps: PlanStep[] = [];
    for (let i = 0; i < raw.length; i++) {
      const step = PlanStep.fromDict(raw[i] as Record<string, unknown>);

      for (const name of stepNodeNames(step)) {
        if (workflowNodeIds !== null) {
          if (!workflowNodeIds.has(name)) {
            throw new GraphDefinitionError(`计划第 ${i} 步引用工作流约束域外节点: ${name}`);
          }
          if (!(name in graph.nodes)) {
            throw new GraphDefinitionError(`计划第 ${i} 步引用工作流节点不在当前图: ${name}`);
          }
        } else if (!(name in graph.nodes)) {
          throw new GraphDefinitionError(`计划第 ${i} 步引用未知节点: ${name}`);
        }
      }

      if (step.condition !== null && (edge_registry === null || !edge_registry.has(step.condition))) {
        throw new GraphDefinitionError(`计划第 ${i} 步条件未注册: ${step.condition}`);
      }

      for (const item of step.spawns) {
        validateSpawnItem(item, i);
      }

      if (step.kind === KIND_SPAWNS) {
        const normalized: Record<string, unknown>[] = [];
        for (const item of step.spawns) {
          const entry = { ...item };
          if (isGraphLike(entry.subgraph)) {
            entry.subgraph = entry.subgraph.to_dict();
          }
          normalized.push(entry);
        }
        steps.push(new PlanStep({ kind: step.kind, spawns: normalized, condition: step.condition }));
        continue;
      }

      if (step.kind === KIND_NODES && step.nodes.length > 1) {
        for (const name of step.nodes) {
          steps.push(new PlanStep({ kind: KIND_NODES, nodes: [name], condition: step.condition }));
        }
        continue;
      }

      steps.push(step);
    }

    if (policy === 'strict') {
      validateStrictOrder(steps, graph, workflow);
    } else if (policy !== 'loose') {
      throw new GraphDefinitionError(`未知计划策略: ${policy}`);
    }

    return new Plan({ steps });
  }
}

function stepNodeNames(step: PlanStep): readonly string[] {
  if (step.kind === KIND_NODES || step.kind === KIND_PARALLEL) {
    return step.nodes;
  }
  return [];
}

function validateSpawnItem(item: Record<string, unknown>, stepIndex: number): void {
  const subgraph = item.subgraph;
  if (subgraph === null || subgraph === undefined) {
    throw new GraphDefinitionError(`计划第 ${stepIndex} 步 spawn 项缺 subgraph`);
  }
  const state = item.state;
  if (state !== null && state !== undefined && !isRecord(state)) {
    throw new GraphDefinitionError(`计划第 ${stepIndex} 步 spawn 项状态须为 dict`);
  }
  const index = item.index;
  if (index !== null && index !== undefined) {
    const num = typeof index === 'number' ? index : Number(index);
    if (Number.isNaN(num)) {
      throw new GraphDefinitionError(`计划第 ${stepIndex} 步 spawn 项序号非法: ${JSON.stringify(index)}`);
    }
  }
}

function validateStrictOrder(
  steps: readonly PlanStep[],
  graph: Graph,
  workflow: WorkflowSpec | null,
): void {
  let workflowEdges: Set<string> | null = null;
  if (workflow !== null) {
    workflowEdges = new Set(
      workflow.edges.map((e) => `${e.source}->${e.target}`),
    );
  }

  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1]!;
    const next = steps[i]!;
    const prevTails = stepTails(prev);
    const nextHeads = stepHeads(next);
    if (prevTails.length === 0) continue;

    let linked = false;
    let domain = '';

    if (workflowEdges !== null) {
      domain = '工作流约束域';
      for (const tail of prevTails) {
        for (const head of nextHeads) {
          if (workflowEdges.has(`${tail}->${head}`)) {
            linked = true;
            break;
          }
        }
        if (linked) break;
      }
    } else {
      domain = '图约束';
      for (const tail of prevTails) {
        const edges = graph.edges[tail] ?? [];
        for (const head of nextHeads) {
          if (edges.some((e) => e.target === head)) {
            linked = true;
            break;
          }
        }
        if (linked) break;
      }
    }

    if (!linked) {
      throw new GraphDefinitionError(
        `严格序计划不满足${domain}: ${JSON.stringify(prevTails)} -> ${JSON.stringify(nextHeads)} 无边关联`,
      );
    }
  }
}

function stepTails(step: PlanStep): readonly string[] {
  if (step.kind === KIND_NODES) {
    return step.nodes.length > 0 ? [step.nodes[step.nodes.length - 1]!] : [];
  }
  if (step.kind === KIND_PARALLEL) {
    return [...step.nodes];
  }
  return [];
}

function stepHeads(step: PlanStep): readonly string[] {
  if (step.kind === KIND_NODES) {
    return step.nodes.length > 0 ? [step.nodes[0]!] : [];
  }
  if (step.kind === KIND_PARALLEL) {
    return [...step.nodes];
  }
  return [];
}
