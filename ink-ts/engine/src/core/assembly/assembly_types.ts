/**
 * 输入调配留痕数据形态（assembly.py 数据面移植）：激活留痕（源 + 强度 +
 * 分配档位）+ 激活模式记录（本次激活了什么 + 版本快照）+ 装配产物。
 *
 * frozen 语义由 readonly + 构造期拷贝表达；所有字段 JSON 兼容（落库/
 * 回放契约走 to_dict/from_dict，未知键忽略兼容增量演进）。
 */

import { typeName } from '../json.js';
import { GraphDefinitionError } from '../errors.js';
import type { ContextSource } from '../context/context_types.js';

/**
 * 条目内压缩钩子：源 + 预算 → 摘要视图（非破坏性：原文不动，仅本次调用
 * 使用压缩视图；返回空串 = 不压缩，走默认截断）。
 */
export type EntryCompressor = (source: ContextSource, budget: number) => string;

/** SourceActivation 构造选项（Python dataclass 关键字参映射）。 */
export interface SourceActivationInit {
  source_type: string;
  title?: string;
  weight?: number;
  relevance?: number;
  char_limit?: number;
  mode?: string;
  entry_ref?: string;
  note?: string;
}

/**
 * 单个源的激活留痕（激活模式：源 + 强度 + 分配档位）。
 *
 * - source_type：源类别（context/knowledge/tool/memory/evidence）；
 * - title：源标题（可读定位）；
 * - weight：源权重（可信度/调用频率）；
 * - relevance：任务相关度；
 * - char_limit：分配字符数（0 = 本调用未纳入，见 mode/note）；
 * - mode：分配档位（keep_full/truncate/drop/compressed/fallback_keep）；
 * - entry_ref：知识条目/记忆条目的引用（版本快照外可重建）；
 * - note：档位说明（丢弃原因/保底说明等，审计可读）。
 */
export class SourceActivation {
  readonly source_type: string;
  readonly title: string;
  readonly weight: number;
  readonly relevance: number;
  readonly char_limit: number;
  readonly mode: string;
  readonly entry_ref: string;
  readonly note: string;

  constructor(init: SourceActivationInit) {
    this.source_type = init.source_type;
    this.title = init.title ?? '';
    this.weight = init.weight ?? 0.0;
    this.relevance = init.relevance ?? 0.0;
    this.char_limit = init.char_limit ?? 0;
    this.mode = init.mode ?? '';
    this.entry_ref = init.entry_ref ?? '';
    this.note = init.note ?? '';
  }

  /** 序列化为数据形态（note 为空时省略，镜像 Python to_dict）。 */
  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      source_type: this.source_type,
      title: this.title,
      weight: this.weight,
      relevance: this.relevance,
      char_limit: this.char_limit,
      mode: this.mode,
      entry_ref: this.entry_ref,
    };
    if (this.note) data['note'] = this.note;
    return data;
  }

  /** 从数据形态还原（非 dict 显式拒绝；缺省兜底镜像 Python or 语义）。 */
  static from_dict(data: unknown): SourceActivation {
    if (!is_dict(data)) {
      throw new GraphDefinitionError(
        `激活留痕声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    return new SourceActivation({
      source_type: String(data['source_type'] ?? ''),
      title: String(data['title'] ?? ''),
      weight: Number(data['weight'] ?? 0.0),
      relevance: Number(data['relevance'] ?? 0.0),
      char_limit: Math.trunc(Number(data['char_limit'] ?? 0)),
      mode: String(data['mode'] ?? ''),
      entry_ref: String(data['entry_ref'] ?? ''),
      note: String(data['note'] ?? ''),
    });
  }
}

/** ActivationRecord 构造选项（Python dataclass 关键字参映射）。 */
export interface ActivationRecordInit {
  total_budget: number;
  assembled_chars: number;
  sources?: readonly SourceActivation[];
  version_snapshot?: Record<string, unknown> | null;
  truncated_chars?: number;
  /** 创建时间戳（epoch 秒）；时间 seam 确定性，缺省 now=0。 */
  created_at?: number;
}

/**
 * 激活模式记录（统一留痕：本次调配激活了什么 + 版本快照）。
 *
 * 与留痕最小化原则衔接：记录组装决定（源/权重/预算/版本快照），全量原文
 * 由知识集版本快照重建——两者合起来满足「模型可见皆可从日志重建」。
 */
export class ActivationRecord {
  readonly total_budget: number;
  readonly assembled_chars: number;
  readonly sources: readonly SourceActivation[];
  readonly version_snapshot: Record<string, unknown> | null;
  readonly truncated_chars: number;
  readonly created_at: number;

  constructor(init: ActivationRecordInit) {
    this.total_budget = init.total_budget;
    this.assembled_chars = init.assembled_chars;
    this.sources = init.sources ? [...init.sources] : [];
    this.version_snapshot = init.version_snapshot ? { ...init.version_snapshot } : null;
    this.truncated_chars = init.truncated_chars ?? 0;
    this.created_at = init.created_at ?? 0;
  }

  /** 序列化为数据形态（version_snapshot 按副本留存；truncated_chars 为 0 时省略）。 */
  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      total_budget: this.total_budget,
      assembled_chars: this.assembled_chars,
      sources: this.sources.map((s) => s.to_dict()),
      version_snapshot: this.version_snapshot ? { ...this.version_snapshot } : null,
      created_at: this.created_at,
    };
    if (this.truncated_chars) data['truncated_chars'] = this.truncated_chars;
    return data;
  }

  /** 从数据形态还原（非 dict 显式拒绝；缺省兜底镜像 Python or 语义）。 */
  static from_dict(data: unknown): ActivationRecord {
    if (!is_dict(data)) {
      throw new GraphDefinitionError(
        `激活记录声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const raw_sources = data['sources'] ?? [];
    const sources = Array.isArray(raw_sources)
      ? raw_sources.map((s) => SourceActivation.from_dict(s))
      : [];
    const snapshot = data['version_snapshot'];
    return new ActivationRecord({
      total_budget: Math.trunc(Number(data['total_budget'] ?? 0)),
      assembled_chars: Math.trunc(Number(data['assembled_chars'] ?? 0)),
      sources,
      version_snapshot: is_dict(snapshot) ? { ...snapshot } : null,
      truncated_chars: Math.trunc(Number(data['truncated_chars'] ?? 0)),
      created_at: Number(data['created_at'] ?? 0),
    });
  }
}

/**
 * 一次输入调配的产物（组装文本 + 激活留痕）。
 *
 * 命名区分（ENG9a-24）：本类 = 输入调配产物（InputAssembler assemble 的
 * 返回），与 path_assembler.PathAssemblyResult（路径组装候选结果）同包同
 * 名异义已消除——AssemblyResult 旧名保留为兼容别名（executor 等既有消费
 * 方沿用），新代码一律用区分名。
 */
export class InputAssemblyResult {
  readonly text: string;
  readonly record: ActivationRecord;

  constructor(text: string, record: ActivationRecord) {
    this.text = text;
    this.record = record;
  }
}

// 兼容别名（ENG9a-24）：旧名 AssemblyResult 保留供既有消费方沿用；
// 新代码用 InputAssemblyResult（两处 import 同一类对象）。
export { InputAssemblyResult as AssemblyResult };

/** dict 判定（本文件 from_dict 的形态门禁；复用 json.isRecord 语义）。 */
function is_dict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
