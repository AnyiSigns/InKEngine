/**
 * 会话级骨架校验（P4 §4.1「可写」局部重校验入口的纯逻辑面）。
 *
 * 骨架修改（agent 声明式改目标/增删节点/边/召唤谁）必须经本校验后才可挂载/
 * 沿骨架执行——复用既有校验路径的语义：结构 = 镜像 Graph.compile()（入口/
 * 出口存在、边引用存在、静态边与条件边不混用）、池成员 = 执行体只能来自池
 * （引用的类型名已登记且可执行）、条件名 = 引用已注册条件边、可达 = 入口可
 * 达出口、终态 = 至少一个可达出口落在池终态候选上（无终态候选池 = 退化仅
 * 结构/可达判定）。
 *
 * 本模块为纯函数（零 IO 零宿主）：池视图（has_type/is_terminal/条件注册）
 * 由调用方（runtime.validate_skeleton / 会话回合加载）注入闭包，可独立单测。
 */

import type { ThreadSkeleton } from '../../core/thread_skeleton/index.js';

/** 池视图（调用方注入的当前池/注册表读面；缺省成员 = 跳过对应判定）。 */
export interface SkeletonPoolEnv {
  /** 类型名是否已登记且可执行（执行体来自池的判定）。 */
  has_type?(type_name: string): boolean;
  /** 类型名是否为池内终态候选（登记行 active + flags.terminal）。 */
  is_terminal?(type_name: string): boolean;
  /** 池内是否存在终态候选（缺 false = 退化只做结构/可达校验）。 */
  has_any_terminal?(): boolean;
  /** 条件名是否已注册（边先验注册表；缺省 = 不校验条件引用）。 */
  has_condition?(name: string): boolean;
}

/** 校验结果（ok=true 且 reasons 为空 = 骨架可挂载/执行）。 */
export interface SkeletonCheckResult {
  ok: boolean;
  reasons: readonly string[];
}

/** 骨架结构校验（不依赖池）：入口/出口/节点/边/静态与条件混用/目标引用。
 *  与既有图编译语义对齐（错误消息与 graph compile 口径一致）。 */
export function check_skeleton_structure(skeleton: ThreadSkeleton): SkeletonCheckResult {
  const reasons: string[] = [];
  const nodes = skeleton.nodes;
  const ids = Object.keys(nodes);
  if (ids.length === 0) {
    reasons.push('骨架节点为空');
  }
  if (skeleton.entry === '') {
    reasons.push('骨架缺入口');
  } else if (nodes[skeleton.entry] === undefined) {
    reasons.push(`入口节点不存在: ${skeleton.entry}`);
  }
  if (skeleton.exits.length === 0) {
    reasons.push('骨架无出口（终态缺失）');
  }
  for (const exit of skeleton.exits) {
    if (nodes[exit] === undefined) {
      reasons.push(`出口节点不存在: ${exit}`);
    }
  }
  if (skeleton.active_target !== null && nodes[skeleton.active_target] === undefined) {
    reasons.push(`active_target 节点不存在: ${skeleton.active_target}`);
  }
  for (const nodeId of ids) {
    const type = nodes[nodeId]!.type;
    if (type === undefined || type === '') {
      reasons.push(`节点 ${nodeId} 缺 type（须引用池内类型名）`);
    }
  }
  for (const [from, list] of Object.entries(skeleton.edges)) {
    if (nodes[from] === undefined) {
      reasons.push(`边起点不存在: ${from}`);
    }
    let hasStatic = false;
    let hasConditional = false;
    for (const edge of list) {
      if (edge.target === undefined || edge.target === '') {
        reasons.push(`节点 ${from} 的边缺 target`);
        continue;
      }
      if (nodes[edge.target] === undefined) {
        reasons.push(`节点 ${from}->${edge.target} 目标不存在`);
      }
      if (edge.condition === undefined || edge.condition === '') hasStatic = true;
      else hasConditional = true;
    }
    if (hasStatic && hasConditional) {
      reasons.push(`节点 ${from} 静态边与条件边混用：静态边优先会闷杀条件边，请拆分节点或统一为条件边`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** 池成员校验：每个节点类型已登记可执行 + 条件边引用已注册。 */
export function check_skeleton_pool(
  skeleton: ThreadSkeleton,
  pool: SkeletonPoolEnv,
): SkeletonCheckResult {
  const reasons: string[] = [];
  if (pool.has_type !== undefined) {
    const unknown: string[] = [];
    for (const type of skeleton.node_types()) {
      if (!pool.has_type(type)) unknown.push(type);
    }
    if (unknown.length > 0) {
      reasons.push(`骨架引用未入池类型: ${unknown.join('、')}`);
    }
  }
  if (pool.has_condition !== undefined) {
    const unknown: string[] = [];
    for (const list of Object.values(skeleton.edges)) {
      for (const edge of list) {
        if (
          edge.condition !== undefined
          && edge.condition !== ''
          && !pool.has_condition(edge.condition)
        ) {
          unknown.push(edge.condition);
        }
      }
    }
    if (unknown.length > 0) {
      reasons.push(`骨架引用未注册条件: ${unknown.join('、')}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** 可达 + 终态校验：入口沿边（任意条件边 = 潜在走向）可达 ≥1 出口；且当池
 *  存在终态候选时至少一个可达出口为终态候选（防骨架绕开终态出口自循环）。 */
export function check_skeleton_reachable(
  skeleton: ThreadSkeleton,
  pool: SkeletonPoolEnv,
): SkeletonCheckResult {
  const reasons: string[] = [];
  const reachable = new Set<string>();
  const queue = [skeleton.entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const edge of skeleton.edges[current] ?? []) {
      if (!reachable.has(edge.target)) queue.push(edge.target);
    }
  }
  const reachableExits = skeleton.exits.filter((exit) => reachable.has(exit));
  if (reachableExits.length === 0) {
    reasons.push('入口不可达任何出口（骨架不可终止）');
  }
  const terminalOf = (exit: string): boolean => {
    if (pool.is_terminal === undefined) return false;
    const type = skeleton.nodes[exit]?.type ?? exit;
    return pool.is_terminal(type);
  };
  const poolHasTerminal = pool.has_any_terminal === undefined ? false : pool.has_any_terminal();
  if (poolHasTerminal && reachableExits.length > 0) {
    if (!reachableExits.some((exit) => terminalOf(exit))) {
      reasons.push('无可达的终态出口（骨架出口须落在池内终态候选上）');
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** 全量校验入口（结构 + 池成员 + 可达/终态）。 */
export function validate_skeleton_impl(
  skeleton: ThreadSkeleton,
  pool: SkeletonPoolEnv,
): SkeletonCheckResult {
  const reasons: string[] = [];
  for (const check of [check_skeleton_structure, check_skeleton_pool, check_skeleton_reachable]) {
    const partial = check(skeleton, pool);
    reasons.push(...partial.reasons);
  }
  return { ok: reasons.length === 0, reasons };
}
