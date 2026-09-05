/**
 * 检索原语数据形态与常量（retrieval.py 常量/哨兵/seam 面移植）。
 *
 * 检索原语 =「接口 + 注册表 + 合并排序 + 注入防线」：检索源（FTS/向量/
 * MCP 等）统一经 Retriever 接口接入，结果作调配器源注入（relevance 排序 +
 * 可信度分级标记）——web < dialog < model < user 的来源分级在 chunk 上
 * 透传，注入侧按级过滤；指令注入扫描对检索文本强制执行，检出即剔除
 * （检索结果不可信）。检索执行体由宿主/领域层注册（文档库/FTS 索引/
 * 向量库 = 领域层，不落引擎）；未知检索源/空结果 = 空清单（检索是增强，
 * 不阻断回合）。
 *
 * 指令注入扫描 seam：默认扫描器 = knowledge_gate.scan_text_injection
 * （真实指令措辞检出：中英文句式 + 混淆熵启发）；宿主可注入等价实现
 * 覆盖（如更严/领域专属措辞表）。
 *
 * 来源分级常量/顺序/默认可信度基准经 source_grading 单源重导出（与知识
 * 集/记忆同口径，无第二份定义）。
 */

import { KIND_PATH, KIND_SCRIPT } from '../knowledge_set/_types.js';
import {
  SOURCE_DIALOG,
  SOURCE_MODEL,
  SOURCE_ORDER,
  SOURCE_USER,
  SOURCE_WEB,
  _SOURCE_CREDIBILITY,
} from '../source_grading/sourceGrading.js';
import { scan_text_injection } from '../knowledge_gate/_injection.js';

// 来源分级重导出（来源分级常量与默认可信度基准 = source_grading 单源；
// 知识集/记忆消费方沿用 retrieval.SOURCE_* 形态）
export { SOURCE_DIALOG, SOURCE_MODEL, SOURCE_ORDER, SOURCE_USER, SOURCE_WEB };
export { _SOURCE_CREDIBILITY };

/** 上下文注入排除的执行类 kind：path/script = 执行物（路径图/脚本载荷），
 *  不是 prompt 文本——检索侧剔除，防执行数据污染注入上下文（消费分派：
 *  path 走路径组装先例层，script 走工具执行，均不进上下文注入）。 */
export const INJECTION_EXCLUDED_KINDS: ReadonlySet<string> = new Set([
  KIND_PATH,
  KIND_SCRIPT,
]);

/** 来源分级次序（SOURCE_ORDER 的查表形态；单源派生的分级权重，与知识集/
 *  记忆同口径）——合并排序的次键（同相关度时高分级靠前）。 */
export const _LEVEL_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  SOURCE_ORDER.map((name, index) => [name, index] as [string, number]),
);

/** 注册表默认配额（防检索源无限膨胀；宿主可参数化）。 */
export const DEFAULT_MAX_RETRIEVERS = 32;

/** 单次检索默认条数与合并上限（钳制注入上下文体积）。 */
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 50;

/** 指令注入扫描面：检索文本 → 命中清单（检出即剔除，不放行）。 */
export type InjectionScanner = (content: string) => readonly string[];

/** 缺省指令注入扫描器 = 真实指令措辞检出（knowledge_gate.scan_text_injection：
 *  中英文指令句式归一命中 + 混淆熵启发）；宿主可注入等价实现覆盖。 */
export const DEFAULT_INJECTION_SCANNER: InjectionScanner = scan_text_injection;

/** RetrievedChunk 构造选项（dataclass 字段映射；meta 缺省空表）。 */
export interface RetrievedChunkOptions {
  source: string;
  doc_id: string;
  text: string;
  relevance?: number;
  level?: string;
  meta?: Readonly<Record<string, unknown>> | null;
}

/**
 * 一条检索结果（注入侧消费的统一形态；frozen 语义由 readonly 表达）。
 *
 * source: 检索源名（注册表内的源标识，如 fts/vector/mcp_search）；
 * doc_id: 文档/条目 id（源内唯一）；text: 检索文本（注入上下文的主体）；
 * relevance: 相关度（0-1，合并排序主键）；level: 来源可信度分级
 * （web/dialog/model/user，注入防线的分级依据）；meta: 扩展元数据
 * （命中位置/时间等，宿主语义）。
 */
export class RetrievedChunk {
  readonly source: string;
  readonly doc_id: string;
  readonly text: string;
  readonly relevance: number;
  readonly level: string;
  readonly meta: Record<string, unknown>;

  constructor(options: RetrievedChunkOptions) {
    this.source = options.source;
    this.doc_id = options.doc_id;
    this.text = options.text;
    this.relevance = options.relevance ?? 0.0;
    this.level = options.level ?? SOURCE_WEB;
    this.meta = options.meta ? { ...options.meta } : {};
  }

  /** 序列化（to_dict 产物可直接重建等价 chunk——往返无损）。 */
  to_dict(): RetrievedChunkOptions {
    return {
      source: this.source,
      doc_id: this.doc_id,
      text: this.text,
      relevance: this.relevance,
      level: this.level,
      meta: { ...this.meta },
    };
  }
}

/**
 * 检索源接口（插拔：新增检索源 = 注册实现，引擎零改动）。
 *
 * 实现要求：name 唯一；retrieve 返回相关度降序清单（引擎不代排序——
 * 源内排序更接近语义实现）；失败应抛异常由注册表兜底（检索失败不
 * 击穿回合）。
 */
export interface Retriever {
  readonly name: string;
  retrieve(query: string, options: { limit: number }): Promise<RetrievedChunk[]>;
}