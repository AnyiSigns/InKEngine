/**
 * 会话级骨架 host 接线点（P4-B-1 目标 3；供 P4-B-2 自修改工具面消费）。
 *
 * 现状结论：host 现有工具面无改图/计划结构动作——rounds.todos 只是引擎计划/
 * 审批卡的只读投影，agent 结构修改全部走契约自指工具（propose_patch/
 * apply_patch 等，目标 = 资产层补丁链），尚无面向会话级骨架（_thread_skeleton）
 * 的声明式动作。本模块提供该动作落地时的可调封装：先经 runtime.validate_skeleton
 * （引擎公开校验入口：结构/池成员/可达/终态）校验，通过才把骨架写入回合
 * state 保留键（随 checkpoint 落库）——新工具属 UI/命令面范畴留 P4-B-2。
 *
 * 数据纪律与引擎一致：骨架只引用池内类型名，不携带任何类型定义/实体/技能
 * 定义；本模块只接线不实现机制语义。
 */

import {
  COND_ROUTE_PREFIX,
  THREAD_SKELETON_STATE_KEY,
  TYPE_ROUTER_JUDGE,
  ThreadSkeleton,
  register_route_edge_condition,
} from '@ink-ts/engine';
import type { Runtime } from '@ink-ts/engine';

/** 骨架校验结果（引擎 SkeletonCheckResult 形态；host 不重复定义语义）。 */
export interface SkeletonValidation {
  ok: boolean;
  reasons: readonly string[];
}

/** router_judge 节点 config.routes 出边条件预注册结果（注册失败 = 校验拒绝原因）。 */
export interface SkeletonRoutePreRegister {
  ok: boolean;
  reasons: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 归一路由候选条目形态（与引擎 router 节点 config.routes 同源：字符串或
 *  {key,label?,description?}；畸形条目跳过，防误伤整体预注册）。 */
function routeKeysOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const key = item.trim();
      if (key !== '' && !seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
      continue;
    }
    if (isRecord(item) && typeof item['key'] === 'string') {
      const key = (item['key'] as string).trim();
      if (key !== '' && !seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

/** 骨架 sketch → router 走向 key 预注册（#8 收敛点：骨架挂载/编辑路径统一
 *  入口——宿主在 validate 前先调用，否则 route:<key> 条件无法被声明式图解析）。
 *
 *  语义：改后的骨架若含 router_judge 实例且出边携带 `route:*` 条件（未注册），
 *  自动从该节点 config.routes 提取 key 并逐一登记（幂等）；key 非法
 *  （空/含 ':'）或注册失败 = 校验拒绝原因（fail-closed）。未命中出边条件的
 *  router config key 不登记（保持最小副作用）；graph_registries 未装配 =
 *  交由 validate 层统一拒绝，本函数不拦。 */
export function pre_register_skeleton_routes(
  runtime: Runtime | null,
  sketch: unknown,
): SkeletonRoutePreRegister {
  const registries = runtime?.graph_registries ?? null;
  if (registries === null) return { ok: true, reasons: [] };
  const data =
    sketch instanceof ThreadSkeleton
      ? sketch.to_dict()
      : isRecord(sketch)
        ? sketch
        : null;
  if (data === null) return { ok: true, reasons: [] };
  const nodes = data['nodes'];
  const edges = data['edges'];
  if (!isRecord(nodes) || !isRecord(edges)) return { ok: true, reasons: [] };
  const reasons: string[] = [];
  for (const [nodeId, nodeSpec] of Object.entries(nodes)) {
    if (!isRecord(nodeSpec) || nodeSpec['type'] !== TYPE_ROUTER_JUDGE) continue;
    const outEdges = edges[nodeId];
    if (!Array.isArray(outEdges)) continue;
    const hasRouteCondition = outEdges.some(
      (edge) => isRecord(edge) && typeof edge['condition'] === 'string'
        && (edge['condition'] as string).startsWith(COND_ROUTE_PREFIX),
    );
    if (!hasRouteCondition) continue;
    const config = isRecord(nodeSpec['config']) ? nodeSpec['config'] : null;
    for (const key of routeKeysOf(config === null ? null : config['routes'])) {
      const name = `${COND_ROUTE_PREFIX}${key}`;
      if (registries.edges.has(name)) continue;
      try {
        register_route_edge_condition(registries, key);
      } catch (error) {
        reasons.push(`路由条件预注册失败（${nodeId} route:${key}）: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** 校验通过后挂载结果（mounted=true = 已写入 state 保留键）。 */
export interface SkeletonMountResult extends SkeletonValidation {
  mounted: boolean;
}

/** runtime.validate_skeleton 的鸭子读面（未装配 = 显式不可用空态）。 */
interface SkeletonValidatingRuntime {
  validate_skeleton?(sketch: unknown): SkeletonValidation;
}

/** 校验入口 host 可调封装：代理 runtime.validate_skeleton（sketch = 序列化
 *  数据 dict 或 ThreadSkeleton 实例）；runtime 未装配入口 = 显式拒绝不编造。 */
export function validate_skeleton_sketch(
  runtime: Runtime | null,
  sketch: unknown,
): SkeletonValidation {
  const validating = runtime as unknown as SkeletonValidatingRuntime | null;
  if (validating === null || typeof validating.validate_skeleton !== 'function') {
    return { ok: false, reasons: ['运行时未装配 validate_skeleton（骨架校验不可用）'] };
  }
  const check = validating.validate_skeleton(sketch);
  return { ok: check.ok, reasons: [...check.reasons] };
}

/** 校验通过才把骨架写入回合 state 的 _thread_skeleton 保留键（随 checkpoint
 *  落库恢复；未通过 = 不落写并返回原因）。data 形态与引擎一致：dict 或
 *  ThreadSkeleton 实例（dict 深拷贝防调用方后续改写污染已挂载骨架）。
 *  挂载前先做 router route:* 出边条件预注册（#8 收敛点；预注册失败 = 拒绝）。 */
export function mount_skeleton_to_state(
  runtime: Runtime | null,
  state: Record<string, unknown>,
  sketch: unknown,
): SkeletonMountResult {
  const routes = pre_register_skeleton_routes(runtime, sketch);
  if (!routes.ok) return { ok: false, mounted: false, reasons: [...routes.reasons] };
  const check = validate_skeleton_sketch(runtime, sketch);
  if (!check.ok) return { ...check, mounted: false };
  const data =
    sketch instanceof ThreadSkeleton
      ? sketch.to_dict()
      : (JSON.parse(JSON.stringify(sketch)) as Record<string, unknown>);
  state[THREAD_SKELETON_STATE_KEY] = data;
  return { ok: true, reasons: [], mounted: true };
}
