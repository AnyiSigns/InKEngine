/**
 * Runtime 自指上下文/端点探活/工具索引/装配源提供者（runtime.py 移植）。
 *
 * _self_context：自指工具执行上下文（装配产物 + 配方钩子组装，运行期取用）。
 * _assembly_sources：调配器源提供者——检索结果 + 知识注入 → 装配源（回合内
 * 节点预装配消费）；无检索源/空结果/调配未启用 = 空清单（检索是增强）。
 *
 * MCP 端点探活：MCP 会话管理器为宿主 seam（未注入 = 未启用），本地端点恒
 * 可用；未注册工具返回 null（调用方自行兜底）。
 */

import { SOURCE_EVIDENCE } from '../assembly/index.js';
import type { ContextSource } from '../context/context_types.js';
import { ContextSource as ContextSourceImpl } from '../context/context_types.js';
import { EndpointType } from '../declarative_tools/index.js';
import {
  _SOURCE_CREDIBILITY,
  build_knowledge_sources,
  type KnowledgeEntry,
} from '../knowledge_set/index.js';
import type { ToolSpec } from '../llm/tools.js';
import type { RetrievedChunk } from '../retrieval/index.js';
import { SelfToolContext } from '../self_tools/index.js';
import { RuntimeUiComponents } from './_runtime_ui.js';
import { _ASSEMBLY_SOURCE_LIMIT } from './_constants.js';

/** 装配源上下文桩（state.input = 查询串）。 */
export type AssemblyCtx = { state?: Record<string, unknown> };

/** 自指/索引/装配源提供基座。 */
export abstract class RuntimeContexts extends RuntimeUiComponents {
  /** 打 thread 标签 + 持久化（request_tool 绑定落地面）。 */
  async _tag_tool_persist(name: string, tag: string): Promise<void> {
    this.tag_tool(name, tag);
    await this._persist_thread_tags();
  }

  /** 自指工具执行上下文（装配产物 + 配方钩子组装，运行期取用）。 */
  _self_context(): SelfToolContext {
    const recipe = this._recipe;
    const convergence =
      recipe !== null && recipe.convergence_provider !== null
        ? recipe.convergence_provider()
        : null;
    return new SelfToolContext({
      self_pipeline: this.self_pipeline!,
      harness_registry: this.harness_registry,
      knowledge_set: this.knowledge_set,
      convergence,
      interrupt_policy: this._host_policy,
      tool_index: this.tool_index,
      tool_tagger: (name, tag) => this._tag_tool_persist(name, tag),
      endpoint_probe: (name) => this._probe_tool_endpoint(name),
    });
  }

  /** 工具端点探活（绑定/检索响应标注：绑定 ≠ 端点可用）。 */
  _probe_tool_endpoint(name: string): Record<string, unknown> | null {
    const declarative = this.harness_registry?.declarative;
    const definition =
      declarative !== undefined ? declarative.definitions[name] : undefined;
    if (definition === undefined || definition === null) return null;
    const endpoint = (definition as unknown as { endpoint?: string }).endpoint;
    if (endpoint === EndpointType.MCP) {
      const server_id = (
        (definition as unknown as { endpoint_config?: Record<string, unknown> | null })
          .endpoint_config ?? {}
      )['server_id'];
      const manager = this.mcp_manager as
        | ({ list_servers?: () => readonly string[] } | null);
      const connected = Boolean(
        server_id
        && typeof server_id === 'string'
        && manager !== null
        && manager.list_servers !== undefined
        && manager.list_servers().includes(server_id),
      );
      return { endpoint: 'mcp', server_id, connected };
    }
    return { endpoint, connected: true };
  }

  /** 重建工具向量索引（全量 merged_specs → 向量；索引未装配 = no-op）。 */
  _rebuild_tool_index(): void {
    if (this.tool_index === null) return;
    this.tool_index.build(this.merged_specs(), this._tool_endpoints());
  }

  /** 增量刷新工具索引（工具增改 / MCP 挂载 hook 调用）。 */
  refresh_tool_index(specs?: readonly ToolSpec[] | null): void {
    if (this.tool_index === null) return;
    const target = specs ?? this.merged_specs();
    this.tool_index.refresh(target, this._tool_endpoints());
  }

  /** 工具端点类型映射（供索引元数据标注）。 */
  _tool_endpoints(): Record<string, string> {
    const endpoints: Record<string, string> = {};
    for (const spec of this.introspection_specs) endpoints[spec.name] = 'introspection';
    for (const spec of this.self_specs) endpoints[spec.name] = 'self';
    for (const name of Object.keys(this.tool_registry)) endpoints[name] = 'declarative';
    return endpoints;
  }

  /** 检索 chunk 的可信度映射权重（复用 _SOURCE_CREDIBILITY，缺省 model 级）。 */
  _chunk_weight(level: string | undefined): number {
    if (level === undefined || level === null) {
      return _SOURCE_CREDIBILITY['model'] ?? 0.7;
    }
    return _SOURCE_CREDIBILITY[level] ?? (_SOURCE_CREDIBILITY['model'] ?? 0.7);
  }

  /** 调配器源提供者：检索结果 + 知识注入 → 装配源清单。 */
  _assembly_sources(): (ctx: AssemblyCtx) => Promise<unknown[]> {
    return async (ctx: AssemblyCtx): Promise<unknown[]> => {
      const query = String(ctx.state?.['input'] ?? '').trim();
      if (!query) return [];
      const chunks: RetrievedChunk[] = this.retriever_registry
        ? await this.retriever_registry.retrieve(query, { limit: _ASSEMBLY_SOURCE_LIMIT })
        : [];
      const knowledgeHits: KnowledgeEntry[] = [];
      const sources: ContextSource[] = [];
      for (const chunk of chunks) {
        const entryId = (chunk.meta ?? {})['entry_id'];
        if (
          chunk.source === 'knowledge'
          && entryId
          && this.knowledge_set !== null
        ) {
          const entry = this.knowledge_set.get(String(entryId));
          if (entry !== null) {
            knowledgeHits.push(entry);
            continue;
          }
        }
        sources.push(
          new ContextSourceImpl(SOURCE_EVIDENCE, chunk.text.slice(0, 1200), {
            title: `检索：${chunk.source}/${chunk.doc_id}`,
            relevance: chunk.relevance,
            priority: 5,
            weight: this._chunk_weight(chunk.level),
            meta: { source: chunk.source, doc_id: chunk.doc_id },
          }),
        );
      }
      if (this.knowledge_set !== null) {
        const ks = this.knowledge_set;
        sources.push(
          ...build_knowledge_sources(knowledgeHits, {
            relevance: 0.5,
            source_type: SOURCE_EVIDENCE,
            max_chars: 1200,
          }),
        );
      }
      // 知识使用留痕：命中条目记 usage（演化候选数据源；失败归因在回合收尾
      // 钩子按成败标记 fail）。零记录不阻断装配。
      for (const entry of knowledgeHits) {
        this._round_knowledge_hits.add(entry.id);
        try {
          this.knowledge_set!.record_usage(entry.id);
        } catch {
          // 使用留痕失败（忽略）
        }
      }
      return sources;
    };
  }
}
