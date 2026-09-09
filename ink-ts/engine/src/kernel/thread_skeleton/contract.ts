/**
 * thread_skeleton 机制件契约声明：会话级骨架（线程尺度会话数据的校验面）。
 *
 * 契约面：本机制为纯数据/纯校验叶子——effects 空（不自持 IO、不消费任何端口）；
 * depends 空（只依赖 core 数据形态与调用方注入的池视图，无值面机制依赖）。
 * 运行侧（runtime 回合加载/保存/续跑状态机）由 kernel/runtime 经本机制的
 * 校验函数组装——机制本身不装配任何引擎产物。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** thread_skeleton 机制契约：纯校验叶子（零端口、零值依赖）。 */
export const thread_skeleton_contract: MechanismContract = {
  id: 'thread_skeleton',
  contract: {
    effects: [],
  },
  depends: [],
};
