/**
 * kernel/thread_skeleton 公开 re-export（会话级骨架校验/转换面）。
 *
 * 机制件 = 纯校验叶子（见 contract.ts）：结构/池成员/可达/终态四段校验
 * （validate.ts）+ 骨架 ↔ 回合图定义数据互转（convert.ts）。池视图由调用方
 * 注入（runtime 或测试），本模块零 IO 零宿主依赖。
 */

export {
  check_skeleton_pool,
  check_skeleton_reachable,
  check_skeleton_structure,
  validate_skeleton_impl,
} from './validate.js';
export type { SkeletonCheckResult, SkeletonPoolEnv } from './validate.js';

export { derive_skeleton_from_graph, skeleton_to_graph_data } from './convert.js';

export { thread_skeleton_contract } from './contract.js';
