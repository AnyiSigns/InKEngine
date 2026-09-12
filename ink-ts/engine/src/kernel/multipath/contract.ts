/**
 * multipath 机制件契约声明（多径展开：候选独立实例引擎执行 + 汇流裁决）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——runner 基底经注入的
 * Storage seam 做支流恢复（tail_checkpoint 读 checkpoint 版本链取链尾，
 * 中断/未终态支流从自身子链续跑），汇流收口把裁决与边证据更新落边证据
 * 记录（EdgeEvidenceStore 注入面），属 storage_seam 端口面（0-IO：不自持
 * IO，只经声明端口读回链尾/落记录）；无模型调用（不列 llm_port）、无执行
 * 信封（不列 exec_envelope；子链执行经 executor 机制承接）、不消费回合
 * 组装端口（不列 rounds.port；恢复续跑语义经 recovery 值 seam 复用）。
 *
 * depends = 值面机制清单：interrupt（InterruptSignal 中断信号语义）、
 * recovery（tail_checkpoint 支流链尾恢复）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../../dock/ports.js';

/** multipath 机制契约：依赖 interrupt/recovery，消费 storage_seam 读链尾/落汇流记录。 */
export const multipath_contract: MechanismContract = {
  id: 'multipath',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: ['interrupt', 'recovery'],
};
