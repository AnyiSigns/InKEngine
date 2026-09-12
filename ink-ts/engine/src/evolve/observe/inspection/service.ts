/**
 * 引擎内省服务（introspection.py IntrospectionService 移植）：按工具名
 * 分发快照读取（单一入口，快照互相独立）。
 *
 * 快照皆为确定性 JSON 数据，出口统一经 make_introspection_executor 内的
 * strip_sensitive 脱敏——snapshot* 裸方法返回未脱敏原始快照，禁止裸调；
 * 图/界面等数据源在 TS 侧以显式类型/注册表 seam 表达（不反射 JS 对象），
 * 宿主装配时经 IntrospectionSources 注入。
 */
import type { Json } from '../../../model/json.js';
import { deepCopy, isRecord } from '../../../model/json.js';
import { KIND_RULE } from '../../../core/knowledge_set/_types.js';
import type { KnowledgeEntry } from '../../../core/knowledge_set/knowledge_entry.js';
import { SEVERITY_ERROR } from '../../../model/rules/_types.js';
import { _DEFAULT_KNOWLEDGE_LIMIT, _KNOWLEDGE_LIMIT_MAX, IntrospectionSources } from './sources.js';

/**
 * 引擎内省服务：按工具名分发快照读取。
 *
 * 单例持有 IntrospectionSources（宿主装配时注入）；图结构观察子面
 * （set_graph/snapshot_graph）已随组装链路退役（W7-B）。
 */
export class IntrospectionService {
  private readonly _sources: IntrospectionSources;

  constructor(sources: IntrospectionSources) {
    this._sources = sources;
  }

  /** 按工具名返回对应快照；未知工具名显式拒绝（fail-closed）。
   *
   * 警告：本方法返回未脱敏的原始快照，禁止裸调——须经
   * make_introspection_executor 出口（strip_sensitive）脱敏后，凭据等敏感键
   * 才不进入模型上下文。
   */
  snapshot(tool_name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
    if (tool_name === 'inspect_rules') return this.snapshot_rules();
    if (tool_name === 'inspect_knowledge') return this.snapshot_knowledge(args['limit']);
    if (tool_name === 'inspect_ui') return this.snapshot_ui();
    if (tool_name === 'inspect_tools') return this.snapshot_tools();
    if (tool_name === 'inspect_entities') return this.snapshot_entities();
    throw new Error(`未知内省工具: '${tool_name}'`);
  }

  /** 规则集快照：集内规则条目清单（id/严重级/说明/规则体）。 */
  snapshot_rules(): Record<string, unknown> {
    const knowledge = this._sources.knowledge_set;
    if (knowledge === null) {
      return { rules: [], count: 0 };
    }
    const rules: Record<string, unknown>[] = [];
    for (const entry of knowledge.entries()) {
      if (entry.kind !== KIND_RULE) continue;
      const raw = entry.data['rule'];
      const body: unknown = Object.prototype.hasOwnProperty.call(entry.data, 'rule')
        ? raw
        : entry.data;
      const is_body_dict = isRecord(body);
      rules.push({
        // 缺省严重度补全：声明数据省略默认 error 级（Rule.to_dict 不输出
        // 默认值），快照须呈现真实语义而非 null
        id: is_body_dict ? (body['id'] === undefined ? null : body['id']) : null,
        severity: is_body_dict ? (body['severity'] || SEVERITY_ERROR) : null,
        description: is_body_dict ? (body['description'] || '') : null,
        rule: body,
      });
    }
    return { rules, count: rules.length };
  }

  /** 知识集快照：按层级/种类统计 + 近期条目概览（limit 限制条数）。
   *
   * limit 钳制在 [1, 100]（与工具 schema 声明一致）：负值/越界输入不
   * 静默失真，越界取声明上限。
   */
  snapshot_knowledge(limit?: unknown): Record<string, unknown> {
    const knowledge = this._sources.knowledge_set;
    if (knowledge === null) {
      return { entries: [], count: 0, by_kind: {}, by_level: {} };
    }
    const entries = knowledge.entries();
    const coerced: unknown = (limit as unknown) || _DEFAULT_KNOWLEDGE_LIMIT;
    const raw_limit = Math.trunc(Number(coerced));
    const capped_limit = Math.max(1, Math.min(raw_limit, _KNOWLEDGE_LIMIT_MAX));
    const capped = Math.min(capped_limit, entries.length);
    const by_kind: Record<string, number> = {};
    const by_level: Record<string, number> = {};
    for (const entry of entries) {
      by_kind[entry.kind] = (by_kind[entry.kind] ?? 0) + 1;
      by_level[entry.level] = (by_level[entry.level] ?? 0) + 1;
    }
    const overview = entries.slice(0, capped).map((entry: KnowledgeEntry) => ({
      id: entry.id,
      kind: entry.kind,
      level: entry.level,
      title: entry.title,
      tags: [...entry.tags],
      credibility: entry.credibility,
      usage_count: entry.usage_count,
    }));
    return {
      entries: overview,
      count: entries.length,
      by_kind,
      by_level,
    };
  }

  /** 界面描述快照：当前 JSON 布局（未定形时为 null）。
   *
   * 返回深拷贝——快照是观察数据，消费方改写不得反写引擎源数据。
   */
  snapshot_ui(): Record<string, unknown> {
    return {
      ui_spec: this._sources.ui_spec === null ? null : deepCopy(this._sources.ui_spec as Json),
    };
  }

  /** 工具表快照：注入面清单 + 全量注册面清单（AI 内省自身能力清单）。
   *
   * 注入面（tools）= 本回合工具参数实际携带的工具（保底/内省/自指 +
   * 本会话 request_tool 绑定）；全量注册面（registered_tools）= 工具
   * 注册表全部已注册工具（含未注入、经 request_tool 绑定即可调用的）。
   * 两张清单分开呈现：以注入面为准做本回合可用性判断，以注册面为准
   * 了解「还能绑定什么」——避免把未注入工具误当本回合直接可调。
   */
  snapshot_tools(): Record<string, unknown> {
    const injected = [...this._sources.tools];
    const injected_names = new Set(injected.map((spec) => spec.name));
    const registered = [...this._sources.registered_tools];
    const tools = injected.map((spec) => ({
      name: spec.name,
      description: spec.description,
      permissions: [...spec.permissions],
    }));
    // 注册面条目精简（name + 权限 + 摘要首行）：全量描述塞进单条工具结果
    // 会被宿主按模型窗口截断，count/registered_count 必须靠前且清单整体
    // 控制在工具结果预算内——模型需要「能绑什么」，细节走
    // search_tools/request_tool 的完整 schema。
    const registered_only = registered
      .filter((spec) => !injected_names.has(spec.name))
      .map((spec) => ({
        name: spec.name,
        description: spec.description ? spec.description.split(/\r\n|\r|\n/)[0] : '',
        permissions: [...spec.permissions],
      }));
    const snapshot: Record<string, unknown> = {
      count: tools.length,
      tools,
      registered_count: registered_only.length,
      registered_tools: registered_only,
    };
    const registry = this._sources.harness_registry;
    if (registry !== null) {
      snapshot['harnesses'] = [...registry.names()];
    }
    return snapshot;
  }

  /** 实体目录快照：已注册实体清单（id/label/model 引用）。
   *
   * 不含 persona 全文（目录概览保持有界；persona 随实体演化经
   * propose_patch(kind=entity) 落链）。实体是数据（可复用、可演化），
   * 快照只出目录形态供 AI 认知可召唤的协作者。
   */
  snapshot_entities(): Record<string, unknown> {
    const registry = this._sources.entity_registry;
    if (registry === null) {
      return { entities: [], count: 0 };
    }
    const entities = registry.specs().map((spec) => ({
      id: spec.id,
      label: spec.label,
      model: spec.model !== null && spec.model !== undefined ? { ...spec.model } : null,
    }));
    return { entities, count: entities.length };
  }
}
