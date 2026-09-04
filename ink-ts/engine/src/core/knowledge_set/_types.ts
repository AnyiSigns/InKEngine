/**
 * 知识集域数据形态与常量（knowledge_set.py 常量/哨兵/seam 面移植）。
 *
 * 层级/类别/错误码/上限常量单点定义；SOURCE_* 与 _SOURCE_CREDIBILITY 经
 * source_grading 重导出（外部消费方沿用 knowledge_set.SOURCE_* 形态）；
 * 存储/时钟/uuid 为 seam——core 零 IO，实现由宿主注入，缺省确定值
 * （now=0、id 固定串）供纯逻辑复现。
 */

import type { ContextSource } from '../context/context_types.js';
import type { Clock } from '../context/context_types.js';
import { GraphDefinitionError } from '../errors.js';
import type { Json, JsonRecord } from '../json.js';
import type { Path } from '../patch/types.js';
import {
  SOURCE_DIALOG,
  SOURCE_MODEL,
  SOURCE_ORDER,
  SOURCE_USER,
  SOURCE_WEB,
  _SOURCE_CREDIBILITY,
  default_credibility as _default_credibility,
} from '../source_grading/sourceGrading.js';

// 来源分级重导出（来源分级常量/顺序/默认可信度基准 = source_grading 单源）
export { SOURCE_DIALOG, SOURCE_MODEL, SOURCE_ORDER, SOURCE_USER, SOURCE_WEB };
export { _SOURCE_CREDIBILITY };
export type { Clock, ContextSource, Json, JsonRecord, Path };

/** 按来源取默认可信度（未知来源 = 模型级，保守不激进）。 */
export function default_credibility(source: string): number {
  return _default_credibility(source);
}

// ── 知识层级（晋升方向固定：工作流水账 → 项目沉淀 → 用户毕业）──

export const LEVEL_WORK = 'work';
export const LEVEL_PROJECT = 'project';
export const LEVEL_USER = 'user';

/** 层级枚举（校验/晋升顺序共用的普通数组——Python _LEVELS 元组形态）。 */
export const _LEVELS: readonly string[] = [LEVEL_WORK, LEVEL_PROJECT, LEVEL_USER];

export type KnowledgeLevel = (typeof LEVEL_VALUES)[number];

/** 层级合法值（可辨识联合的原料；非法层级在构造/反序列化期拒绝）。 */
export const LEVEL_VALUES = [LEVEL_WORK, LEVEL_PROJECT, LEVEL_USER] as const;

export function isKnowledgeLevel(value: unknown): value is KnowledgeLevel {
  return (LEVEL_VALUES as readonly unknown[]).includes(value);
}

// 层级晋升方向（工作 → 项目 → 用户，顺序固定——先沉淀后压缩）
export const _LEVEL_ORDER: Readonly<Record<string, number>> = {
  [LEVEL_WORK]: 0,
  [LEVEL_PROJECT]: 1,
  [LEVEL_USER]: 2,
};

// ── 上限与默认（魔法数字数据化）──

/** 条目失败日志留存上限（反思式变异的输入窗口：只留近期，防无限膨胀）。 */
export const _MAX_FAILURE_LOGS = 20;

/** 条目渲染软上限（非 rule/insight 条目的 JSON 摘要截断——渲染层防超长
 *  data 撑爆注入上下文；截断带溢出标记，留痕可重建）。 */
export const _MAX_RENDER_CHARS = 4000;

/** 复用检索默认上限（检索 = 复用优先于生成的窗口，取 5 条命中即够决策）。 */
export const DEFAULT_SEARCH_LIMIT = 5;

// ── 知识条目对外错误码（桥接透传不泄露内部字段形态）──

export const KS_ERR_INVALID_LEVEL = 'KS_001';
export const KS_ERR_CREDIBILITY_RANGE = 'KS_002';
export const KS_ERR_GATE_TYPE = 'KS_003';

// ── 知识条目 kind（规则/模板/权重/工具规则/教训/路径技能/脚本）──

export const KIND_RULE = 'rule';
export const KIND_TEMPLATE = 'template';
export const KIND_WEIGHT = 'weight';
export const KIND_TOOL_RULE = 'tool_rule';
export const KIND_INSIGHT = 'insight';
// path = 证据化路径技能（结晶路径图 + 证据快照 + 测试报告，消费方 = 路径组装）；
// script = 确定性脚本技能（外部 SKILL.md 脚本段导入形态，消费方 = 工具执行）
export const KIND_PATH = 'path';
export const KIND_SCRIPT = 'script';

/** path 技能条目的容器内集合前缀（技能 id 稳定命名 = skill:<name>@v<version>）。 */
export const SKILL_ID_PREFIX = 'skill:';

// ── 存储集合（knowledge:<user_id> 用户集，集内补丁链唯一）──

export const _COLLECTION_PREFIX = 'knowledge:';
export const _CHAIN_KEY = 'chain';

/** 种子条目 id 前缀（回退种子基线的过滤依据：注入开关关闭时仅种子注入）。 */
export const SEED_ID_PREFIX = 'seed.';

// ── seam 声明（core 零 IO：时间/随机/存储均由宿主注入实现）──

/** 新条目 id 提供者（镜像 Python uuid 短前缀；缺省 = 固定串，确定性复现）。 */
export type EntryIdProvider = () => string;

/** 知识集存储的最小契约：get_record + put_record（duck-typed，不绑定宿主
 *  Storage 全量接口，core 只用 records 通道两原语）。 */
export interface KnowledgeStorage {
  get_record(collection: string, key: string): Promise<Record<string, unknown> | null>;
  put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void>;
}

/** 指令注入扫描面：渲染内容 → 命中清单（knowledge_gate.scan_text_injection
 *  未迁移前的注入点；检出即剔除，不放行）。 */
export type InjectionScanner = (content: string) => readonly string[];

/** 落库闸门单项结果（L1 准入/L2 效果评估/L3 目标筛选共形）。 */
export interface KnowledgeGateResult {
  passed: boolean;
  /** L1 校验错误集（truthy = 未通过原因；空 = 通过）。 */
  errors?: unknown;
  /** L2 效果评估备注。 */
  note?: unknown;
  /** L3 目标筛选理由。 */
  reason?: unknown;
}

/** 落库闸门评估选项（L2 含完整样例库执行——样例不绿在存储边界即被拒绝）。 */
export interface KnowledgeGateCheckOptions {
  schema?: unknown;
  fixtures?: unknown;
  regression?: unknown;
  new_metrics?: Record<string, number> | null;
  old_metrics?: Record<string, number> | null;
}

/** 知识闸门 seam：check 返回三关结果（duck-check，未注入 = 调用方自行把关）。 */
export interface KnowledgeGateLike {
  check(
    entry: unknown,
    options: KnowledgeGateCheckOptions,
  ): Promise<readonly [KnowledgeGateResult, KnowledgeGateResult, KnowledgeGateResult]>;
}

/** 修正方法 value 参数的空值哨兵（显式 null 与未传区分——精准补丁可
 *  合法地写入 null）。 */
export const _UNSET = Symbol('knowledge_set.unset');

/** KnowledgeEntry 构造期形态校验错误（层级/可信度越界——内部字段形态
 *  不裸透，文案统一携带 KS_ 错误码）。 */
export function entryShapeError(code: string, message: string): GraphDefinitionError {
  return new GraphDefinitionError(`[${code}] ${message}`);
}