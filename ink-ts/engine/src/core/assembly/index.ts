/**
 * core/assembly 公开 re-export（snake_case 镜像 Python assembly.__all__）。
 *
 * 输入调配把上下文调配器（core/context）从「组件」接线为「执行语义」：
 * 每次 LLM 调用/节点执行前统一走输入调配——上下文片段 + 知识集注入 +
 * 工具集裁剪 + 记忆召回 + 证据组装多源在调用点统一调配。本模块只做组装
 * 与留痕（薄管线），不碰业务。
 *
 * 文件拆分纪律（≤350 行/文件）：常量/配置落 assembly_config；激活留痕
 * 数据形态落 assembly_types；利用率聚合落 activation_aggregator；调配
 * 执行体落 input_assembler。
 */

export {
  DEFAULT_ASSEMBLY_BUDGET,
  DEFAULT_CONTEXT_RATIO,
  DEFAULT_EVIDENCE_RATIO,
  DEFAULT_KNOWLEDGE_RATIO,
  DEFAULT_MEMORY_RATIO,
  DEFAULT_TOOL_RATIO,
  DEFAULT_TOTAL_BUDGET,
  MODE_COMPRESSED,
  SOURCE_CONTEXT,
  SOURCE_EVIDENCE,
  SOURCE_KNOWLEDGE,
  SOURCE_MEMORY,
  SOURCE_TOOL,
  AssemblyConfig,
} from './assembly_config.js';
export type { AssemblyConfigInit } from './assembly_config.js';

// DEFAULT_MAX_TOOLS：装配层与工具调配层同口径（每轮 3-14 个经验框架，
// tool_orchestrator 单点定义，assembly.__all__ 沿 python 一并导出）
export { DEFAULT_MAX_TOOLS } from '../tool_orchestrator/_types.js';

export { DEFAULT_COLD_WINDOW, DEFAULT_OVERHEATED_RATE } from './activation_aggregator.js';

export {
  ActivationRecord,
  AssemblyResult,
  InputAssemblyResult,
  SourceActivation,
} from './assembly_types.js';
export type { ActivationRecordInit, EntryCompressor, SourceActivationInit } from './assembly_types.js';

export {
  ActivationAggregator,
  ActivationSummary,
  EntryActivationStats,
} from './activation_aggregator.js';
export type {
  ActivationAggregatorOptions,
  ActivationSummaryInit,
  EntryActivationStatsInit,
} from './activation_aggregator.js';

export { InputAssembler } from './input_assembler.js';
export type { AssembleOptions, InputAssemblerOptions } from './input_assembler.js';
