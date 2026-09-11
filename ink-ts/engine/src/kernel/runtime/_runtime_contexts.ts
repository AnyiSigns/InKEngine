/**
 * Runtime 自指上下文/端点探活/工具索引（runtime.py 移植）。
 *
 * _self_context：自指工具执行上下文（装配产物 + 配方钩子组装，运行期取用）。
 *
 * MCP 端点探活：MCP 会话管理器为宿主 seam（未注入 = 未启用），本地端点恒
 * 可用；未注册工具返回 null（调用方自行兜底）。
 */

import { EndpointType } from '../../core/declarative_tools/index.js';
import type { ToolSpec } from '../llm/tools.js';
import { SelfToolContext } from '../self_tools/index.js';
import { RuntimeUiComponents } from './_runtime_ui.js';

/** 自指/索引基座。 */
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

  /** 摘除工具索引条目（MCP 卸载 hook 调用；缺失静默幂等）。 */
  remove_tool_index(name: string): void {
    if (this.tool_index === null) return;
    this.tool_index.remove(name);
  }

  /** 工具端点类型映射（供索引元数据标注）。 */
  _tool_endpoints(): Record<string, string> {
    const endpoints: Record<string, string> = {};
    for (const spec of this.introspection_specs) endpoints[spec.name] = 'introspection';
    for (const spec of this.self_specs) endpoints[spec.name] = 'self';
    for (const name of Object.keys(this.tool_registry)) endpoints[name] = 'declarative';
    return endpoints;
  }
}
