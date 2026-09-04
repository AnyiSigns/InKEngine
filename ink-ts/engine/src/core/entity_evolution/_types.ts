/**
 * 实体演化闭环数据形态与常量（entity_evolution.py 常量/配置/结果面移植）。
 *
 * 协作者目录的自学习机制（镜像知识孵化管线，机制件复用）：回合事件 →
 * 实体关联失败信号缓冲（同因去重经教训指纹）→ 按需变异（失败信号蒸馏为
 * persona「已知教训」块）→ 三层闸门 → 严格更优替换 → 连续 N 回合零归因
 * 失败晋升。本文件落常量/上限/层级方向与 frozen dataclass 形态
 * （EntityEvolutionConfig / EntityMutationResult）；管线/gate 见同目录
 * pipeline.ts / gate.ts。
 *
 * core 零 IO：时间 seam 确定性（未注入 now=0）；事件发射未注入 = 静默。
 */

import type { EntitySpec } from '../entities/entities.js';
import { LEVEL_PROJECT, LEVEL_USER, LEVEL_WORK } from '../knowledge_set/index.js';

// 协作者召唤工具名（宿主声明式工具；tool_start/tool_end 归因锚）
export const COLLAB_TOOL_NAME = 'collab_request';

// 孵化缓冲上限（按实体跨回合累积但有界：超限丢最旧——防长时间无变异触发时
// 内存膨胀；正常会话远低于此）
export const _MAX_INCUBATING = 64;

// 教训文本截断上限（persona 追加面有界：单条教训只取摘要）
export const _LESSON_CHAR_LIMIT = 160;

// 实体 persona 内常驻教训条数上限（无界追加会让 persona 无限膨胀；达上限
// 后新教训不再追加——变异被 L3 严格更优判定自然拒绝）
export const _MAX_PERSONA_LESSONS = 16;

// 层级晋升方向（工作 → 项目 → 用户；顺序固定，与知识集同语义）
export const _LEVEL_ORDER: Readonly<Record<string, number>> = {
  [LEVEL_WORK]: 0,
  [LEVEL_PROJECT]: 1,
  [LEVEL_USER]: 2,
};

/** EntityEvolutionConfig 构造选项（缺省 = 出厂默认：开启、阈值 1、晋升 3 回合）。 */
export interface EntityEvolutionConfigOptions {
  enabled?: boolean;
  mutate_threshold?: number;
  promotion_rounds?: number;
}

/** 实体演化管线配置（出厂默认开启；无用户可操作项）。
 *
 * - enabled: 观察/变异/晋升全链路开关（False = 回到「无实体演化」基线，
 *   与自学习管线开关同语义）；
 * - mutate_threshold: 单实体变异触发阈值（缓冲失败信号 ≥ 该值才尝试变异；
 *   保守默认 1——同因去重与 L3 严格更优判定已防反复无效变异）；
 * - promotion_rounds: 晋升所需连续零失败回合数（变异后计数）。
 */
export class EntityEvolutionConfig {
  readonly enabled: boolean;
  readonly mutate_threshold: number;
  readonly promotion_rounds: number;

  constructor(options: EntityEvolutionConfigOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.mutate_threshold = options.mutate_threshold ?? 1;
    this.promotion_rounds = options.promotion_rounds ?? 3;
    Object.freeze(this);
  }
}

/** EntityMutationResult 构造选项。 */
export interface EntityMutationResultOptions {
  spec: EntitySpec;
  new_lessons?: number;
}

/** 一次实体变异的产物（新声明 + 新增教训数；供闸门与落位使用）。 */
export class EntityMutationResult {
  readonly spec: EntitySpec;
  readonly new_lessons: number;

  constructor(init: EntityMutationResultOptions) {
    this.spec = init.spec;
    this.new_lessons = init.new_lessons ?? 0;
    Object.freeze(this);
  }
}
