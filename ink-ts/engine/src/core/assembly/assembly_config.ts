/**
 * 输入调配配置面（assembly.py 配置/常量部分移植）：源类别常量 + 统一
 * 预算与分级占比默认 + :class:`AssemblyConfig`。
 *
 * AssemblyConfig = 一次调用的总预算在多源间分级分配（上下文/知识/工具/
 * 记忆/证据不再各自为政）+ 行为开关（一键回退旧装配路径）。校验在构造
 * 期暴露（GraphDefinitionError），非法配置声明期拒绝。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';
import { DEFAULT_MAX_TOOLS } from '../tool_orchestrator/_types.js';

// 源类别（分级预算分配的分组标签；与使用方声明保持一致）
export const SOURCE_CONTEXT = 'context'; // 对话历史/回合上下文
export const SOURCE_KNOWLEDGE = 'knowledge'; // 知识集注入（基线 + 任务激活）
export const SOURCE_TOOL = 'tool'; // 工具定义（集内裁剪）
export const SOURCE_MEMORY = 'memory'; // 记忆召回
export const SOURCE_EVIDENCE = 'evidence'; // 证据组装（web 验证产物）

/** 源类别全集（分组键白名单：未知类别显式拒绝，类别不得漂移）。 */
export const _SOURCE_TYPES = [
  SOURCE_CONTEXT,
  SOURCE_KNOWLEDGE,
  SOURCE_TOOL,
  SOURCE_MEMORY,
  SOURCE_EVIDENCE,
] as const;

// 回退优先级（数值大 = 更晚被丢弃 = 更高优）。回退兜底按此优先级从尾部
// 丢整块：evidence/memory 最先丢，context 最后丢——不依赖 _SOURCE_TYPES
// 元组序，显式可断言。
export const _ROLLBACK_PRIORITY: Record<string, number> = {
  [SOURCE_EVIDENCE]: 0,
  [SOURCE_MEMORY]: 1,
  [SOURCE_TOOL]: 2,
  [SOURCE_KNOWLEDGE]: 3,
  [SOURCE_CONTEXT]: 4,
};

/** 缺省总预算（字符）：对齐宿主旧静态取段 4000 上限的调用点总口径。 */
export const DEFAULT_TOTAL_BUDGET = 8000;

// 分级占比默认值（占调用预算 T 的结构；校验：合计 ≤ 1 防超分——上下文
// 50-70% + 知识 20-40% + 工具 5-10% 为经验区间，记忆/证据从知识预算内
// 细分，默认合计 = 1.0）
export const DEFAULT_CONTEXT_RATIO = 0.5;
export const DEFAULT_KNOWLEDGE_RATIO = 0.3;
export const DEFAULT_TOOL_RATIO = 0.1;
export const DEFAULT_MEMORY_RATIO = 0.05;
export const DEFAULT_EVIDENCE_RATIO = 0.05;
// 工具激活数上限（每轮 3-14 个的经验框架；与工具调配器同源单点定义）
// ——DEFAULT_MAX_TOOLS 从 tool_orchestrator 导入即模块级常量（装配层与
// 调配层同口径），index.ts 按 assembly.__all__ 一并重导出。

/** 缺省装配预算（单次 assemble 未指定时的总预算）。 */
export const DEFAULT_ASSEMBLY_BUDGET = DEFAULT_TOTAL_BUDGET;

/** 组装期条目内压缩（非破坏性摘要视图）的激活留痕模式。 */
export const MODE_COMPRESSED = 'compressed';

/** AssemblyConfig 构造选项（Python dataclass 关键字参映射）。 */
export interface AssemblyConfigInit {
  enabled?: boolean;
  total_budget?: number;
  context_ratio?: number;
  knowledge_ratio?: number;
  tool_ratio?: number;
  memory_ratio?: number;
  evidence_ratio?: number;
  max_tools?: number;
}

/** 源类别 → 分级占比（统一预算的分配比例，防各自为政）。 */
export function ratio_for(config: AssemblyConfig, kind: string): number {
  switch (kind) {
    case SOURCE_CONTEXT:
      return config.context_ratio;
    case SOURCE_KNOWLEDGE:
      return config.knowledge_ratio;
    case SOURCE_TOOL:
      return config.tool_ratio;
    case SOURCE_MEMORY:
      return config.memory_ratio;
    case SOURCE_EVIDENCE:
      return config.evidence_ratio;
    default:
      return 0.0;
  }
}

/**
 * 输入调配配置（统一预算 + 分级占比 + 行为开关）。
 *
 * - enabled：行为开关（False = 装配禁用，调用点回退旧路径）；
 * - total_budget：一次调用的总预算（字符；多源分级分配的硬上界）；
 * - context_ratio/knowledge_ratio/tool_ratio/memory_ratio/evidence_ratio：
 *   分级占比（合计 ≤ 1 防超分）；
 * - max_tools：工具激活数上限（每轮 3-14 个）。
 */
export class AssemblyConfig {
  readonly enabled: boolean;
  readonly total_budget: number;
  readonly context_ratio: number;
  readonly knowledge_ratio: number;
  readonly tool_ratio: number;
  readonly memory_ratio: number;
  readonly evidence_ratio: number;
  readonly max_tools: number;

  constructor(init: AssemblyConfigInit = {}) {
    const enabled = init.enabled ?? true;
    const total_budget = init.total_budget ?? DEFAULT_TOTAL_BUDGET;
    const context_ratio = init.context_ratio ?? DEFAULT_CONTEXT_RATIO;
    const knowledge_ratio = init.knowledge_ratio ?? DEFAULT_KNOWLEDGE_RATIO;
    const tool_ratio = init.tool_ratio ?? DEFAULT_TOOL_RATIO;
    const memory_ratio = init.memory_ratio ?? DEFAULT_MEMORY_RATIO;
    const evidence_ratio = init.evidence_ratio ?? DEFAULT_EVIDENCE_RATIO;
    const max_tools = init.max_tools ?? DEFAULT_MAX_TOOLS;
    if (total_budget <= 0) {
      throw new GraphDefinitionError(`装配总预算必须为正: ${total_budget}`);
    }
    const ratios = [context_ratio, knowledge_ratio, tool_ratio, memory_ratio, evidence_ratio];
    if (ratios.some((r) => r < 0 || r > 1)) {
      throw new GraphDefinitionError(`分级占比必须在 [0, 1] 内: [${ratios.join(', ')}]`);
    }
    const ratio_sum = ratios.reduce((acc, r) => acc + r, 0);
    if (ratio_sum > 1.0) {
      throw new GraphDefinitionError(
        `分级占比合计超限（必须 ≤ 1，防超分）: ${ratio_sum.toFixed(2)}`,
      );
    }
    if (max_tools < 1) {
      throw new GraphDefinitionError(`工具激活数上限必须为正: ${max_tools}`);
    }
    this.enabled = enabled;
    this.total_budget = total_budget;
    this.context_ratio = context_ratio;
    this.knowledge_ratio = knowledge_ratio;
    this.tool_ratio = tool_ratio;
    this.memory_ratio = memory_ratio;
    this.evidence_ratio = evidence_ratio;
    this.max_tools = max_tools;
  }

  /** 源类别 → 分级预算池（总预算 × 占比，向下取整）。 */
  pool_for(source_type: string): number {
    return Math.trunc(this.total_budget * ratio_for(this, source_type));
  }

  /** 序列化为数据形态（JSON 进 JSON 出，落库契约）。 */
  to_dict(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      total_budget: this.total_budget,
      context_ratio: this.context_ratio,
      knowledge_ratio: this.knowledge_ratio,
      tool_ratio: this.tool_ratio,
      memory_ratio: this.memory_ratio,
      evidence_ratio: this.evidence_ratio,
      max_tools: this.max_tools,
    };
  }

  /** 从数据形态还原（非 dict 显式拒绝；缺省兜底镜像 Python or 语义）。 */
  static from_dict(data: unknown): AssemblyConfig {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `装配配置声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    return new AssemblyConfig({
      enabled: Boolean(data['enabled'] ?? true),
      total_budget: Math.trunc(Number(data['total_budget'] ?? DEFAULT_TOTAL_BUDGET)),
      context_ratio: Number(data['context_ratio'] ?? DEFAULT_CONTEXT_RATIO),
      knowledge_ratio: Number(data['knowledge_ratio'] ?? DEFAULT_KNOWLEDGE_RATIO),
      tool_ratio: Number(data['tool_ratio'] ?? DEFAULT_TOOL_RATIO),
      memory_ratio: Number(data['memory_ratio'] ?? DEFAULT_MEMORY_RATIO),
      evidence_ratio: Number(data['evidence_ratio'] ?? DEFAULT_EVIDENCE_RATIO),
      max_tools: Math.trunc(Number(data['max_tools'] ?? DEFAULT_MAX_TOOLS)),
    });
  }
}
