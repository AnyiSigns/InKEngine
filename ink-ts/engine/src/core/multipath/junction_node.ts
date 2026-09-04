/**
 * Junction 节点类型（multipath.py Junction 节点段移植，1:1）。
 *
 * JunctionExecutor = 汇流执行体（节点型用途的依赖持有者；裁决核心复用）。
 * 工厂以本对象为实时引用（依赖装配期后置注入：质量闸门/合成源随运行期
 * 绑定），节点执行时现取——与注册表工厂的实时引用契约一致。未装配/未
 * 绑定依赖时节点执行显式失败（不静默）。
 *
 * 数据形态：支流清单经状态通道（multipath.branches）注入；执行 = 汇流
 * 裁决 → 产物 overlay + 裁决记录（multipath.verdict）回流；审计记录经
 * sink/回调发出（append-only；本模块只产出不落库）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';
import { EdgeEvidenceStore } from '../edge_evidence/index.js';
import type { QualityGate } from '../contracts/contracts.js';
import { NodeTypeRegistry } from '../registry/registry.js';
import type { NodeFn } from '../registry/registry_types.js';
import {
  DEFAULT_DOMAIN,
  JUNCTION_BRANCHES_STATE_KEY,
  JUNCTION_TYPE,
  JUNCTION_VERDICT_STATE_KEY,
} from './constants.js';
import { junction_audit_record } from './updates.js';
import { JunctionBranch } from './junction_types.js';
import { junction_verdict } from './verdict.js';
import type { JunctionSynthProvider } from './verdict.js';

/** 汇流执行体（Junction 节点型用途的依赖持有者；裁决核心复用）。 */
export class JunctionExecutor {
  readonly evidence_store: EdgeEvidenceStore | null;
  readonly sink: ((record: Record<string, unknown>) => void) | null;
  readonly now: number | null;
  quality_gate: QualityGate | null;
  synth_provider: JunctionSynthProvider | null;

  constructor(init: {
    evidence_store?: EdgeEvidenceStore | null;
    sink?: ((record: Record<string, unknown>) => void) | null;
    now?: number | null;
  } = {}) {
    this.evidence_store = init.evidence_store ?? null;
    this.sink = init.sink ?? null;
    this.now = init.now ?? null;
    this.quality_gate = null;
    this.synth_provider = null;
  }

  /** 运行期依赖绑定（节点执行前由使用方接线）。 */
  bind(init: {
    quality_gate?: QualityGate | null;
    synth_provider?: JunctionSynthProvider | null;
  } = {}): void {
    this.quality_gate = init.quality_gate ?? null;
    this.synth_provider = init.synth_provider ?? null;
  }
}

/** Junction 节点执行体（数据形态：支流清单经状态通道注入）。 */
export function _junction_node(executor: JunctionExecutor | null): NodeFn {
  return async (ctx: unknown): Promise<Record<string, unknown> | null> => {
    if (executor === null) {
      throw new GraphDefinitionError(
        'Junction 节点执行需要汇流执行体（register_junction_node 注入）',
      );
    }
    const state = (ctx as { state?: Record<string, unknown> }).state ?? {};
    const raw_branches = state[JUNCTION_BRANCHES_STATE_KEY];
    if (!Array.isArray(raw_branches) || raw_branches.length === 0) {
      throw new GraphDefinitionError(
        `Junction 节点缺失支流清单（${JUNCTION_BRANCHES_STATE_KEY}）`,
      );
    }
    const branches = raw_branches
      .filter((b): b is Record<string, unknown> => isRecord(b))
      .map((b) => JunctionBranch.from_dict(b));
    const domain = String(state['domain'] ?? DEFAULT_DOMAIN);
    const raw_goal = state['goal'];
    const goal = Array.isArray(raw_goal) ? (raw_goal as unknown[]) : [];
    const verdict = await junction_verdict(branches, {
      domain,
      goal: goal.map((g) => String(g)),
      quality_gate: executor.quality_gate,
      synth_provider: executor.synth_provider,
      now: executor.now,
    });
    if (executor.sink !== null) {
      executor.sink(
        junction_audit_record(verdict, branches, {
          domain,
          ts: executor.now !== null ? executor.now : Date.now() / 1000,
        }),
      );
    }
    const overlay: Record<string, unknown> = { ...verdict.selection };
    overlay[JUNCTION_VERDICT_STATE_KEY] = verdict.to_dict();
    return overlay;
  };
}

/**
 * 注册 Junction 节点类型（重复注册显式拒绝；装配处调用）。
 *
 * 机制开关关闭时装配处不调用本函数 = 类型不存在 = 引用图定义在建图期
 * 被拒（Junction 不参与执行——默认全关的零影响语义）。
 */
export function register_junction_node(
  registry: NodeTypeRegistry,
  opts: { executor?: JunctionExecutor | null } = {},
): void {
  const executor = opts.executor ?? null;
  if (registry.has(JUNCTION_TYPE)) {
    throw new GraphDefinitionError(`节点类型重复注册: ${JUNCTION_TYPE}`);
  }
  registry.register(JUNCTION_TYPE, () => _junction_node(executor));
}
