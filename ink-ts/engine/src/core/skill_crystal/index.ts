/**
 * 技能结晶域公开 re-export（snake_case 镜像 Python skill_crystal.__all__）。
 *
 * 文件拆分纪律：常量落 _types；条目值对象落 skill_entry；纯机制（分类/
 * 命中率/测试报告）落 mechanism；存储 seam 落 storage_seam、默认内存实现
 * 落 in_memory、SkillStore 封装落 skill_store；知识集合并容器互转落
 * knowledge_merge、容器存储落 knowledge_skill_store；组装结晶落
 * assembly_skill；导出落 export；缓存自动结晶 + 沉淀钩子落 crystallize。
 *
 * Python 模块级可导但不在 __all__ 的合并/容器成员（skill_to_knowledge_entry /
 * knowledge_entry_to_skill / KnowledgeSkillStore 等）供接线侧取用，一并重导出。
 */

export {
  SKILL_HIT_MIN_DEFAULT,
  SKILL_KIND_PATH,
  SKILL_KIND_VISUAL,
  SKILL_SUCCESS_RATE_DEFAULT,
} from './_types.js';
export type { SkillKind } from './_types.js';

export { SkillEntry } from './skill_entry.js';
export type { SkillEntryOptions } from './skill_entry.js';

export { build_test_report, classify_skill_kind } from './mechanism.js';

export { SkillStore } from './skill_store.js';
export type { SkillStoreOptions } from './skill_store.js';

export { InMemorySkillStorage } from './in_memory.js';
export type { SkillRow, SkillStorage } from './storage_seam.js';

export {
  knowledge_entry_to_skill,
  skill_to_knowledge_entry,
} from './knowledge_merge.js';

export { KnowledgeSkillStore } from './knowledge_skill_store.js';
export type { KnowledgeSkillStoreOptions } from './knowledge_skill_store.js';

export { build_assembly_skill_entry } from './assembly_skill.js';
export type {
  AssemblyCandidateLike,
  AssemblyVerdictLike,
  EvidenceEdgeLike,
  SkillGraphLike,
} from './assembly_skill.js';

export { export_skill } from './export.js';

export { SkillCrystallizeHook, crystallize_from_cache } from './crystallize.js';
export type {
  CacheEntryLike,
  CacheEntrySource,
  SkillStoreLike,
} from './crystallize.js';
