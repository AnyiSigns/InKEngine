/**
 * spawn 机制件契约声明：动态子图展开原语的数据面。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——spawn 承载子任务
 * 清单的模型/校验/实例归属（SpawnSpec / SpawnFailure / SpawnResult、
 * collect_spawn_specs、instance_thread_id / instance_entry_state），为纯
 * 数据面运算（图 = 数据：清单子图可为实例或图定义数据，经 resolve_graph
 * 重建，可跨进程传递、随版本化语义携带）；清单的并发展开与结果回收由
 * 执行器承担，本机制不直接消费执行信封/存储/模型/回合端口。0-IO：不自持
 * IO。
 *
 * depends 为空：spawn 不直接依赖任何其它机制件（子图重建依赖 core
 * graph / schema / reducers 数据面）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** spawn 机制契约：零机制间依赖，零副作用端口（展开清单数据面）。 */
export const spawn_contract: MechanismContract = {
  id: 'spawn',
  contract: {
    effects: [],
  },
  depends: [],
};
