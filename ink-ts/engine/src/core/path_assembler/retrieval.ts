/**
 * 内存暴力 top-N 兜底检索器（path_assembler.py「内存暴力 top-N 兜底检索器」段移植）。
 *
 * 默认注入实现，与向量栈解耦；计分 = 产出字段 ∩ 目标字段数（检索只管
 * 「把谁拿给草稿源看」——检索相似度 ≠ 信任：信任只来自运行结果（边证据），
 * 两套分数永不混用）。查询串 = 引擎约定 JSON（goal/entry/pool 字段名清单）。
 */

import { required_field_names, produced_field_names } from '../link_validator/link_validator.js';
import type { NodeContract } from '../contracts/contracts.js';
import { RetrievedChunk, type Retriever } from '../retrieval/index.js';

/** 结点摘要文本（检索结果文本；供草稿层上下文展示）。 */
function _node_text(type_name: string, contract: NodeContract): string {
  const inputs = [...required_field_names(contract.input_schema)].sort();
  const outputs = [...produced_field_names(contract.output_schema)].sort();
  const inputsText = inputs.length > 0 ? inputs.join(',') : '无';
  const outputsText = outputs.length > 0 ? outputs.join(',') : '无';
  return `${type_name} 输入=${inputsText} 输出=${outputsText} 安全档=${contract.safety_tier}`;
}

/** 内存暴力 top-N 兜底（默认注入实现；向量栈上线后换注入实现复测）。 */
export class InMemoryPoolRetriever implements Retriever {
  readonly name = 'in_memory_pool';
  private readonly _pool: Record<string, NodeContract>;

  constructor(pool: Record<string, NodeContract>) {
    this._pool = { ...pool };
  }

  async retrieve(query: string, options: { limit: number }): Promise<RetrievedChunk[]> {
    let goal = new Set<string>();
    try {
      const payload = JSON.parse(query) as Record<string, unknown>;
      const goalRaw = payload['goal'];
      if (Array.isArray(goalRaw)) {
        goal = new Set(goalRaw.map(String));
      }
    } catch {
      goal = new Set();
    }
    const scored: Array<{ overlap: number; type_name: string; contract: NodeContract }> = [];
    for (const type_name of Object.keys(this._pool)) {
      const contract = this._pool[type_name]!;
      const produced = produced_field_names(contract.output_schema);
      let overlap = 0;
      for (const name of goal) {
        if (produced.has(name)) overlap += 1;
      }
      scored.push({ overlap, type_name, contract });
    }
    scored.sort((a, b) => {
      if (a.overlap !== b.overlap) return b.overlap - a.overlap;
      return a.type_name < b.type_name ? -1 : a.type_name > b.type_name ? 1 : 0;
    });
    const limit = options.limit ?? 1;
    const capped = Math.max(1, Math.min(Math.trunc(limit), scored.length));
    const denom = Math.max(1, goal.size);
    return scored.slice(0, capped).map(({ overlap, type_name, contract }) => {
      return new RetrievedChunk({
        source: this.name,
        doc_id: type_name,
        text: _node_text(type_name, contract),
        relevance: overlap / denom,
      });
    });
  }
}
