/**
 * skill_crystal 机制件契约声明（技能结晶：指纹缓存达标条目 → 可分享技能）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——结晶经注入的缓存与
 * 技能存储对象读写记录：缓存枚举（entries）读达标条目，技能落位走
 * SkillStorage seam（整行写/按指纹取/枚举行，宿主注入持久实现；引擎默认
 * 接线经 KnowledgeSkillStore 落知识集 kind=path 条目，同属记录落位面），
 * 属 storage_seam 端口面（0-IO：不自持 IO，只经声明存储面读写）；分类/
 * 命名/命中率/测试报告为纯算法、零 LLM（不列 llm_port），无执行信封
 * （不列 exec_envelope）、不消费回合组装端口（不列 rounds.port）。
 *
 * depends 为空：skill_crystal 不直接依赖任何其它机制件（互转/容器复用
 * core knowledge_set 数据面）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../registry/ports.js';

/** skill_crystal 机制契约：零机制间依赖，消费 storage_seam 缓存/技能存储端口面。 */
export const skill_crystal_contract: MechanismContract = {
  id: 'skill_crystal',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: [],
};
