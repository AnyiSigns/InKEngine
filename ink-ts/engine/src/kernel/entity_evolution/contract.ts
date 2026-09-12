/**
 * entity_evolution 机制件契约声明。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——entity_evolution
 * 本体为零端口消费（effects 为空）：失败信号缓冲/教训指纹去重/确定性变异
 * 蒸馏/三层闸门判定全部是进程内纯逻辑组合；变异落位与晋升经注入的
 * EvolutionWriter 值 seam 走演化写入管线（写入副作用在 evolution_writer
 * 契约面声明，本机制不直接持有存储端口）。回合事件观察（EngineTransport）
 * 与回合收尾触发（settle）均为被注入的入向钩子，不构成端口消费。
 *
 * depends：entity_evolution 组合复用两个下游机制——builder（教训指纹取
 * 其 _sha256 纯实现）与 knowledge_gate（EntityMutationGate 组合复用
 * KnowledgeGate 判定件）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../../dock/registry/contract_types.js';

/** 实体演化机制契约：消费 builder 与 knowledge_gate，effects 为空（零端口）。 */
export const entity_evolution_contract: MechanismContract = {
  id: 'entity_evolution',
  contract: {
    effects: [],
  },
  depends: ['builder', 'knowledge_gate'],
};
