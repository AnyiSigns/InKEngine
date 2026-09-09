/**
 * thread_skeleton 公开面（会话级骨架数据形态）。
 *
 * 骨架 = thread 尺度会话数据（随 checkpoint state 落库/恢复，见
 * THREAD_SKELETON_STATE_KEY），节点/边实例只引用池内已登记类型名——本模块
 * 不携带执行语义/校验逻辑（结构 + 池引用校验在 kernel/thread_skeleton，
 * 运行时读写在 kernel/runtime/_runtime_skeleton）。
 */

export {
  THREAD_SKELETON_STATE_KEY,
  THREAD_SKELETON_VERSION,
  ThreadSkeleton,
} from './types.js';
export type {
  SkeletonEdgeSpec,
  SkeletonNodeSpec,
  ThreadSkeletonStatus,
} from './types.js';
