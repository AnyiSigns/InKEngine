/**
 * 内置种子知识集封装（通用种子：用户集初始化注入的机制基线）。
 *
 * 通用种子 = 引擎内置的最小可用基线：「能跑、能学、能存的空壳」——
 * 默认编排模板（工作流数据形态）+ 默认权重/阈值（调参基线），不含任何
 * 领域成品；每个用户集初始化时注入（幂等，不覆盖使用中演化）。
 *
 * 领域深度归产品层：产品自写领域规则/样例/谓词，直接以知识条目形态
 * 注入（seed_knowledge_set）或经装配配方（AssemblyRecipe.seeds 按
 * (name, provider) 直注）；机制层不持有任何领域内容（架构门禁：机制层
 * 语义中立）。领域校验语义与验证基线（样例库）由产品成对维护——样例
 * 全绿是新规则落库的非谈判项。
 *
 * 种子条目 id 稳定（固定前缀 + 规则 id）：重复初始化经 seed_knowledge_set
 * 幂等跳过，「种子只读基线 + 演化补丁链」的分层语义不因重复注入被破坏。
 */

import {
  KIND_TEMPLATE,
  KIND_WEIGHT,
  LEVEL_WORK,
  SOURCE_MODEL,
  KnowledgeEntry,
  KnowledgeSet,
  seed_knowledge_set,
} from '../knowledge_set/index.js';
import { _SOURCE_CREDIBILITY, SOURCE_USER } from '../source_grading/sourceGrading.js';

// 通用种子条目 id（稳定键：幂等注入与版本回退的锚点）
const GENERAL_TEMPLATE_SEED_ID = 'seed.general.template.default';
const GENERAL_WEIGHTS_SEED_ID = 'seed.general.weights.default';

// 种子条目可信度（来源分级表联动）：引擎随带的种子 = 经过验证的发布物——
// 取值 = 统一来源分级表中最高档（用户确认级 0.9），高于普通对话（0.6）/
// 模型（0.7）来源：种子经出厂验证管线发布，等同用户确认的信任档；分级
// 基准变化时本常量随表联动（不再独立硬编码）
const SEED_CREDIBILITY: number = _SOURCE_CREDIBILITY[SOURCE_USER]!;

// 种子条目工厂签名（装配配方 seeds 直注用）
type SeedProvider = () => KnowledgeEntry[];

/**
 * 通用种子条目（最小可用空壳：默认编排模板 + 默认权重/阈值）。
 *
 * 通用种子不含任何领域成品——「能跑、能学、能存」的基线：
 * - 模板条目：默认编排模板（工作流数据形态，节点名由使用方按图适配）；
 * - 权重条目：评审/校验的默认权重与阈值（调参基线，参数快照的初始形态）。
 */
function build_general_seed_entries(): KnowledgeEntry[] {
  return [
    new KnowledgeEntry({
      id: GENERAL_TEMPLATE_SEED_ID,
      level: LEVEL_WORK,
      kind: KIND_TEMPLATE,
      data: {
        template: {
          name: 'default',
          description: '默认编排模板（空壳：入站 → 执行 → 收口）',
          plan: { steps: [{ nodes: ['start'] }] },
        },
      },
      source: SOURCE_MODEL,
      credibility: SEED_CREDIBILITY,
      title: '默认编排模板',
      tags: ['template', 'default'],
    }),
    new KnowledgeEntry({
      id: GENERAL_WEIGHTS_SEED_ID,
      level: LEVEL_WORK,
      kind: KIND_WEIGHT,
      data: {
        divergence_width: 3,
        retry_budget: 1,
        web_verify_threshold: 0.5,
        weights: { quality: 0.5, consistency: 0.5 },
        thresholds: { pass: 0.6 },
      },
      source: SOURCE_MODEL,
      credibility: SEED_CREDIBILITY,
      title: '默认权重与阈值',
      tags: ['weights', 'thresholds', 'tuning'],
    }),
  ];
}

/**
 * 通用种子注入（每个用户集初始化时调用；幂等，不覆盖演化）。
 */
function seed_general(knowledge_set: KnowledgeSet): number {
  return seed_knowledge_set(knowledge_set, build_general_seed_entries());
}

// __all__ 镜像（Python seeds.__all__ 顺序）
export {
  GENERAL_TEMPLATE_SEED_ID,
  GENERAL_WEIGHTS_SEED_ID,
  SEED_CREDIBILITY,
  build_general_seed_entries,
  seed_general,
};
export type { SeedProvider };