/**
 * executor 机制件契约声明：引擎执行面（回合主循环 / 嵌套子图执行的驱动与
 * 状态机装配）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——executor 经注入的
 * Storage seam 写 checkpoint 与事件日志（options.storage：每节点完成写快照
 * 版本链、终态/中断/异常快照落盘、事件日志 append），属 storage_seam 端口面
 * （0-IO：不自持 IO，只经声明端口落记录）。
 * - llm_port 不列：引擎执行 src 不直接调用模型——仅经 ../llm/guard 的
 *   current_node_context 接线把 LLM 用量记账归到当前节点（值级 import，非
 *   AsyncLLM 调用）；
 * - rounds_port 不列：本机制是回合执行引擎的驱动方而非该端口的消费方
 *   （回合入口在宿主组装/执行运行时侧，本机制只承接恢复解析与审批重入
 *   的执行语义）。
 *
 * depends = 值面机制清单：budget（预算检查）、interrupt（挂起/重入协议）、
 * llm（用量记账守卫接线）、recovery（恢复解析/链尾）、turn_settle（结点级
 * 成败留痕）。spawn/simulation/multipath 展开段已随 P8+S1 退役（不再依赖）。
 * 契约化归属见 engine/src/dock/registry/contract_types.ts。
 */

import type { MechanismContract } from '../../dock/registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../../dock/ports.js';

/** executor 机制契约：消费 storage_seam 落 checkpoint/事件，值依赖执行配套机制集。 */
export const executor_contract: MechanismContract = {
  id: 'executor',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: [
    'budget',
    'interrupt',
    'llm',
    'recovery',
    'turn_settle',
  ],
};
