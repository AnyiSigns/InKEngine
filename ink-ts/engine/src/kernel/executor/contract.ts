/**
 * executor 机制件契约声明：引擎执行面（回合主循环 / 嵌套子图 / spawn 实例 /
 * 推演分支 / 多径展开的驱动与状态机装配）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——executor 经注入的
 * Storage seam 写 checkpoint 与事件日志（options.storage：每节点完成写快照
 * 版本链、终态/中断/异常快照落盘、事件日志 append），属 storage_seam 端口面
 * （0-IO：不自持 IO，只经声明端口落记录）。
 * - llm_port 不列：引擎执行 src 不直接调用模型——仅经 ../llm/guard 的
 *   current_node_context 接线把 LLM 用量记账归到当前节点（值级 import，非
 *   AsyncLLM 调用）；
 * - exec_envelope 不列：spawn/并行组展开把子任务清单并发展开为进程内子引擎
 *   实例（_make_instance_engine 同进程构造，事件/checkpoint 数据流），不启动
 *   沙箱子进程——信封归 spawn/sandbox 侧；
 * - rounds.port 不列：本机制是回合执行引擎的驱动方而非该端口的消费方
 *   （回合入口在宿主组装/执行运行时侧，本机制只承接恢复解析与审批重入
 *   的执行语义）。
 *
 * depends = 值面机制清单：budget（预算检查）、interrupt（挂起/重入协议）、
 * llm（用量记账守卫接线）、multipath（多径展开）、recovery（恢复解析/链尾）、
 * settle（结点级成败留痕）、simulation（推演）、spawn（子任务清单数据面）。
 * path_assembler 不列（机制已随 W7-B 组装链路退役）：多径编排的组装上下文
 * （request/candidates）经节点数据面注入，executor 不反向读组装模块级默认——
 * 候选链路类型已迁 kernel/multipath/types.ts（spawn/multipath 隔离试跑在用）。
 * 契约化归属见 engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
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
    'multipath',
    'recovery',
    'settle',
    'simulation',
    'spawn',
  ],
};
