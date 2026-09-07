/**
 * 内省工具描述与执行器（introspection.py 元工具段移植）。
 *
 * 观察工具是 AI 修改产品形态的前置通道——内省元工具以引擎工具描述
 * （ToolSpec）注册进工具表，经统一工具流水线（runtime 装配的 tool_pipeline，
 * 只读判定 (read, *) / 权限门禁 / 审计 / 截断）执行；内省自身不再自造
 * 独立流水线。快照出口统一过 security.strip_sensitive——观察通道与落库
 * 通道同规格，凭据永不进入模型上下文；快照必须完整可序列化，契约破坏
 * 显式抛错（fail-closed），不静默降级为字符串。
 */
import { ToolSpec } from '../llm/tools.js';
import { strip_sensitive } from '../../core/security/security.js';
import type { Executor } from '../tool_pipeline/_types.js';
import {
  INTROSPECTION_PERMISSION,
  _KNOWLEDGE_LIMIT_MAX,
} from './sources.js';
import { IntrospectionService } from './service.js';

/** 内省元工具的工具描述清单（注册进引擎工具表走统一流水线）。 */
export function introspection_tool_specs(): ToolSpec[] {
  return [
    new ToolSpec({
      name: 'inspect_graph',
      description:
        '读取当前执行图的结构快照（节点/边/出口/子图与内容指纹），供 AI 观察自身运行形态',
      parameters: { type: 'object', properties: {} },
      permissions: [INTROSPECTION_PERMISSION],
    }),
    new ToolSpec({
      name: 'inspect_rules',
      description:
        '读取当前集内规则集快照（规则 id/严重级/说明），供 AI 评估既有规则是否仍合适',
      parameters: { type: 'object', properties: {} },
      permissions: [INTROSPECTION_PERMISSION],
    }),
    new ToolSpec({
      name: 'inspect_knowledge',
      description:
        '读取知识集快照（条目按层级与种类统计 + 近期条目概览），供 AI 了解已沉淀的知识',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: _KNOWLEDGE_LIMIT_MAX,
            description: '概览条目数上限（缺省 20）',
          },
        },
      },
      permissions: [INTROSPECTION_PERMISSION],
    }),
    new ToolSpec({
      name: 'inspect_ui',
      description: '读取当前界面描述快照（JSON 布局），供 AI 了解产品当前呈现形态',
      parameters: { type: 'object', properties: {} },
      permissions: [INTROSPECTION_PERMISSION],
    }),
    new ToolSpec({
      name: 'inspect_tools',
      description:
        '读取工具表快照：注入面（本回合工具参数实际携带的工具，含完整描述）与全量' +
        '注册面（未注入、经 request_tool 绑定即可调用的工具，条目为摘要形态）两个清单，' +
        '附 count/registered_count 计数，供 AI 内省自身能力清单与集内 harness 领域',
      parameters: { type: 'object', properties: {} },
      permissions: [INTROSPECTION_PERMISSION],
    }),
    new ToolSpec({
      name: 'inspect_entities',
      description:
        '读取实体目录快照（已注册协作者清单：id/label/model 引用），供 AI 了解可召唤的协作者',
      parameters: { type: 'object', properties: {} },
      permissions: [INTROSPECTION_PERMISSION],
    }),
  ];
}

/** 构造内省执行器（统一工具流水线 executor 契约：ctx/spec/args/approval → 文本）。
 *  快照出口统一过 security.strip_sensitive 并经 JSON 序列化；未知工具名 =
 *  service.snapshot 显式抛错（fail-closed），不静默降级。 */
export function make_introspection_executor(service: IntrospectionService): Executor {
  const executor: Executor = async (_ctx, spec, args, _approval) => {
    const snapshot = service.snapshot(spec.name, args ?? {});
    // 出口统一剥离敏感键（api_key/token/secret…）——观察通道与落库通道
    // 同规格，凭据永不进入模型上下文；快照必须完整可序列化，契约破坏
    // 显式抛错（fail-closed），不静默降级为字符串
    return JSON.stringify(strip_sensitive(snapshot));
  };
  return executor;
}
