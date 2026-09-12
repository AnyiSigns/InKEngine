/**
 * growth 机制件契约声明（自学习孵化闭环）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——growth 的成长指标
 * 时序面消费 storage_seam：每回合收尾经注入的指标存储对象（MetricStore
 * duck 形态，get_record/put_record 两原语）把快照追加到 growth_metrics
 * 集合（单键滚动缓冲，与审计集合分离），diagnostic 侧再经同一存储读回
 * 时序——属 storage_seam 端口面。知识落位过 KnowledgeGate 三层闸门（进程
 * 内判定，非端口）；蒸馏/复用/观察均不直调 LLM 端口（确定性基线，链缺失
 * 回落确定性蒸馏）。
 *
 * depends：growth 组合复用 knowledge_gate（落位闸门，new KnowledgeGate 或
 * 注入实例）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../../dock/registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../../dock/ports.js';

/** 生长机制契约：依赖 knowledge_gate，消费 storage_seam 指标时序端口面。 */
export const growth_contract: MechanismContract = {
  id: 'growth',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: ['knowledge_gate'],
};
