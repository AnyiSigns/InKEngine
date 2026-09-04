/**
 * 技能结晶域常量（skill_crystal.py 常量面移植）。
 *
 * 数据源：指纹缓存已沉淀的缓存条目（路径序列化 / 证据快照 / 命中失败计数 /
 * 契约快照 / 模型 id / 域）。技能 = 命名化缓存条目；沉淀钩子在读到
 * 「命中数 ≥ N 且命中率 ≥ 阈值」的缓存条目后自动结晶为可分享技能，
 * 阈值为可配置参数，附默认值（可配置；hit 数下限 + 命中率下限，双条件 AND）。
 *
 * 视觉技能扩展：高频成功的视觉路径（输入 = image、输出 = 结构化提取，
 * 对应感知结点 image→描述链路）按同阈值结晶为视觉技能（kind=visual），
 * 结晶逻辑与通用路径完全同构，仅分类标签与导出语义不同。
 */

// ── 结晶阈值默认值（可配置；hit 数下限 + 命中率下限，双条件 AND）──

export const SKILL_HIT_MIN_DEFAULT = 5;
export const SKILL_SUCCESS_RATE_DEFAULT = 0.8;

// ── 技能分类（声明式枚举，防魔法字符串）──

export const SKILL_KIND_PATH = 'path';
export const SKILL_KIND_VISUAL = 'visual';

/** 技能 kind 合法值（path 通用路径技能 / visual 视觉技能）。 */
export type SkillKind = 'path' | 'visual';
