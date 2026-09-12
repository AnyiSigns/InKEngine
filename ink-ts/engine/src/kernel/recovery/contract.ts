/**
 * recovery 机制件契约声明：恢复/续流解析（checkpoint 锚点 + 增量重放）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——recovery 经注入的
 * Storage seam 读回 checkpoint 版本链与事件日志（get_latest_checkpoint /
 * get_checkpoint / chain_index / events_after）作为恢复解析输入，属
 * storage_seam 端口面（0-IO：不自持 IO，只经声明端口读记录；锚点选择、
 * 状态覆盖合并、子图锚点回溯、重放清单编排均为注入数据上的纯解析）。
 * 输入/输出形状以 CheckpointRecord / EngineEvent 为核心，随引擎记录契约
 * 演进。
 *
 * depends 为空：recovery 不直接依赖任何其它机制件（恢复语义的消费方在
 * 执行器 resume 接线侧，本模块只提供解析函数；回合入口/审批重入在消费
 * 方组装，本模块不依赖 rounds.port）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../../dock/ports.js';

/** recovery 机制契约：零机制间依赖，消费 storage_seam 读回 checkpoint 链。 */
export const recovery_contract: MechanismContract = {
  id: 'recovery',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: [],
};
