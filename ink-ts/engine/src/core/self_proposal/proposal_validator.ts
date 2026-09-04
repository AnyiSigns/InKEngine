/**
 * 按补丁类型校验 payload（core/self_proposal.py ProposalValidator 移植）。
 *
 * 校验器依赖注入（缺省 = 基线约束）：ui/theme 三层白名单、harness 的图
 * 注册表（graph 校验需要节点/边类型）、知识条目结构 schema（缺省不校验
 * data 内部形态）。违规清单可读可审计。纯函数无状态（除运行期白名单
 * 更新外），可作模块级复用。
 *
 * 校验语义（每类复用引擎既有校验器，零业务依赖、不发明第二套语义）：
 * - ui：界面描述结构 + 组件/绑定通道/主题 token 三层白名单；
 * - theme：主题 token 增量全部 ∈ 白名单；
 * - tool：声明式工具定义构造即校验（权限/端点白名单缺声明拒绝），
 *   另加命名规范断言（MCP 远程工具豁免）；
 * - rule：规则声明解析校验；
 * - knowledge：知识条目构造校验 + 可选结构 schema；
 * - harness：图定义（validate=True）+ 工具定义 + 默认编排模板；
 * - event_type：事件类型声明构造校验（新事件类型须带 renderer，system 豁免）；
 * - entity：实体声明构造校验；
 * - environment：环境声明构造校验；
 * - artifact：产物声明结构校验（哈希形态）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';
import { DeclarativeToolSpec, EndpointType } from '../declarative_tools/index.js';
import { EntitySpec } from '../entities/entities.js';
import { EnvironmentSpec } from '../environments/spec.js';
import { EventTypeSpec } from '../event_types/eventTypeSpec.js';
import { Graph } from '../graph/graph.js';
import { HarnessDefinition } from '../harness/index.js';
import { KnowledgeEntry } from '../knowledge_set/index.js';
import { Plan } from '../plan/plan.js';
import { GraphRegistries } from '../registry/registry.js';
import { Rule } from '../rules/index.js';
import {
  SchemaSpec,
  SchemaValidator,
  validate_tool_name,
} from '../schema/schemaValidator.js';
import { DEFAULT_BIND_CHANNELS, UISchemaValidator } from '../ui_schema/uiSchema.js';

import { example_skeleton, pyRepr, pyTupleRepr } from './self_proposal.js';
import type { SelfProposal } from './self_proposal.js';

/** ProposalValidator 构造选项（依赖注入；缺省 = 基线约束）。 */
export interface ProposalValidatorInit {
  /** 组件白名单（ui 补丁第一层；缺省空 = 任何组件未注册即违规）。 */
  allowed_components?: readonly string[];
  /** 绑定通道白名单（缺省 = 引擎基线 DEFAULT_BIND_CHANNELS）。 */
  allowed_channels?: readonly string[];
  /** 主题 token 白名单（theme 补丁增量与 ui spec 内 token 共用）。 */
  allowed_theme_tokens?: readonly string[];
  /** 建图注册表（harness 的 graph/plan 校验需要节点/边类型解析）。 */
  graph_registries?: GraphRegistries | null;
  /** 知识条目 data 的结构 schema（缺省不校验 data 内部形态）。 */
  knowledge_schema?: SchemaSpec | null;
}

/**
 * 按补丁类型校验 payload（违规清单可读可审计；空 = 通过）。
 */
export class ProposalValidator {
  private _allowed_components: readonly string[];
  private readonly _allowed_channels: readonly string[];
  private _allowed_theme_tokens: readonly string[];
  private readonly _registries: GraphRegistries;
  private readonly _knowledge_schema: SchemaSpec | null;
  private readonly _ui_validator: UISchemaValidator;

  constructor(init: ProposalValidatorInit = {}) {
    this._allowed_components = init.allowed_components ?? [];
    this._allowed_channels = init.allowed_channels ?? DEFAULT_BIND_CHANNELS;
    this._allowed_theme_tokens = init.allowed_theme_tokens ?? [];
    this._registries = init.graph_registries ?? new GraphRegistries();
    this._knowledge_schema = init.knowledge_schema ?? null;
    this._ui_validator = new UISchemaValidator();
  }

  /** 运行期更新组件白名单（出厂组件停用即时生效；后续 ui 补丁同源）。 */
  set_allowed_components(names: readonly string[]): void {
    this._allowed_components = names;
  }

  /** 校验一条提案：违规清单（空 = 通过）。 */
  validate(proposal: SelfProposal): string[] {
    const methodName = `_validate_${proposal.kind}`;
    const method = (this as unknown as Record<string, unknown>)[methodName];
    if (typeof method !== 'function') {
      return [`未知补丁类型: ${pyRepr(proposal.kind)}`];
    }
    let violations = (method as (payload: Record<string, unknown>) => string[]).call(
      this,
      proposal.payload,
    );
    const example = example_skeleton(proposal.kind);
    if (violations.length > 0 && example !== undefined) {
      // 违规清单尾部附合法形态示例骨架：回传示例供模型按形态收敛
      violations = [...violations, `合法形态示例: ${example}`];
    }
    return violations;
  }

  /** 布尔判定便捷入口（零违规 = True；闸门组装用）。 */
  validate_ok(proposal: SelfProposal): boolean {
    return this.validate(proposal).length === 0;
  }

  /** 违规单条包装（label + 异常消息；违规清单可读可审计）。 */
  private _violations(label: string, exc: GraphDefinitionError): string[] {
    return [`${label}: ${exc.message}`];
  }

  private _validate_ui(payload: Record<string, unknown>): string[] {
    const spec = payload['spec'];
    if (!isRecord(spec)) {
      return ['ui 补丁缺 spec（界面描述 dict）'];
    }
    return this._ui_validator.validate(spec, {
      allowed_components: this._allowed_components,
      allowed_channels: this._allowed_channels,
      allowed_theme_tokens: this._allowed_theme_tokens,
    });
  }

  private _validate_theme(payload: Record<string, unknown>): string[] {
    const tokens = payload['tokens'];
    if (!isRecord(tokens)) {
      return ['theme 补丁缺 tokens（主题 token 增量 dict）'];
    }
    return Object.keys(tokens)
      .filter((key) => !this._allowed_theme_tokens.includes(key))
      .map(
        (key) =>
          `theme token 未声明: ${pyRepr(key)}（白名单 ${pyTupleRepr(this._allowed_theme_tokens)}）`,
      );
  }

  private _validate_tool(payload: Record<string, unknown>): string[] {
    let parsed: DeclarativeToolSpec;
    try {
      parsed = DeclarativeToolSpec.from_dict(payload);
    } catch (exc) {
      if (exc instanceof GraphDefinitionError) return this._violations('tool 补丁非法', exc);
      throw exc;
    }
    const violations: string[] = [];
    // 命名规范断言（新增/自写工具统一执行）：工具名是行为词典的词汇
    // 键，TOOL 补丁即「新增/自写」的声明面——下划线/超长命名在此
    // 拦截（fail-closed 于提案期，不落到审批卡）。豁免面 = MCP 远程
    // 工具（endpoint=mcp）：名字来自第三方服务器清单，不由产品行为
    // 词典管控；豁免由声明数据本身推导，序列化往返不丢。
    if (parsed.endpoint !== EndpointType.MCP) {
      const nameViolations = validate_tool_name(parsed.name);
      if (nameViolations.length > 0) {
        violations.push(
          `tool 补丁非法: 工具名 ${parsed.name} 违反命名规范: ${nameViolations.join('；')}`,
        );
      }
    }
    return violations;
  }

  private _validate_rule(payload: Record<string, unknown>): string[] {
    const rule = payload['rule'];
    if (!isRecord(rule)) {
      return ['rule 补丁缺 rule（规则声明 dict）'];
    }
    try {
      Rule.from_dict(rule);
    } catch (exc) {
      if (exc instanceof GraphDefinitionError) return this._violations('rule 补丁非法', exc);
      throw exc;
    }
    return [];
  }

  private _validate_knowledge(payload: Record<string, unknown>): string[] {
    const entry = payload['entry'];
    if (!isRecord(entry)) {
      return ['knowledge 补丁缺 entry（知识条目 dict）'];
    }
    try {
      KnowledgeEntry.from_dict(entry);
    } catch (exc) {
      if (exc instanceof GraphDefinitionError) return this._violations('knowledge 补丁非法', exc);
      throw exc;
    }
    // 最小结构校验（默认层）：仅过 from_dict 结构仍允许不可信 data 写入
    // 知识集——补齐最小形态闸门，收紧风险面。kind=rule 时 data 须含
    // dict 形态 rule 声明；其余 kind 仅要求 data 为 dict（保持宽松，
    // 宿主可经 knowledge_schema 注入更强校验）。
    const entryKind = entry['kind'];
    const entryData = entry['data'];
    if (!isRecord(entryData)) {
      return ['knowledge 补丁的 data 须为 dict'];
    }
    if (entryKind === 'rule' && !isRecord(entryData['rule'])) {
      return ['knowledge 补丁 kind=rule 时 data 须含 dict 形态 rule 声明'];
    }
    if (this._knowledge_schema !== null) {
      // 注入 schema 校验对象 = entry_data（ENG1-16 口径统一）：与上面
      // 两处结构校验同对象——旧实现校验整条 entry（含 id/level/kind
      // 等条目级字段），与「收紧 data 内部形态」的声明语义不一致；
      // 宿主注入的领域 schema 描述的是 data 字段形态
      return new SchemaValidator().validate(this._knowledge_schema, entryData);
    }
    return [];
  }

  private _validate_harness(payload: Record<string, unknown>): string[] {
    const definition = payload['definition'];
    if (!isRecord(definition)) {
      return ['harness 补丁缺 definition（harness 声明 dict）'];
    }
    try {
      const parsed = HarnessDefinition.from_dict(definition);
      if (parsed.graph !== null) {
        Graph.from_dict(parsed.graph, {
          registry: this._registries.nodes,
          edge_registry: this._registries.edges,
          validate: true,
        });
      }
      for (const toolData of parsed.tools) {
        DeclarativeToolSpec.from_dict(toolData);
      }
      if (parsed.default_plan !== null) {
        const planGraph = Graph.from_dict(parsed.graph, {
          registry: this._registries.nodes,
          edge_registry: this._registries.edges,
          validate: true,
        });
        Plan.parse(parsed.default_plan, {
          graph: planGraph,
          edge_registry: this._registries.edges,
          policy: 'loose',
        });
      }
    } catch (exc) {
      if (exc instanceof GraphDefinitionError) return this._violations('harness 补丁非法', exc);
      throw exc;
    }
    return [];
  }

  private _validate_event_type(payload: Record<string, unknown>): string[] {
    let parsed: EventTypeSpec;
    try {
      parsed = EventTypeSpec.from_dict(payload);
    } catch (exc) {
      if (exc instanceof GraphDefinitionError) return this._violations('event_type 补丁非法', exc);
      throw exc;
    }
    // 新事件类型必须带渲染组件（渲染器引用）：无 renderer = 只能
    // 折叠展示，注册时显式拒绝（事件 → 组件映射的契约）；系统信号
    // 不入回合步骤序列（装配器合成 system_events 注入），豁免
    if (!parsed.renderer && !parsed.system) {
      return [
        'event_type 补丁须带 renderer（前端渲染组件引用）——' +
          '无渲染组件的事件只能折叠展示',
      ];
    }
    return [];
  }

  private _validate_entity(payload: Record<string, unknown>): string[] {
    try {
      EntitySpec.from_dict(payload);
    } catch (exc) {
      if (exc instanceof GraphDefinitionError) return this._violations('entity 补丁非法', exc);
      throw exc;
    }
    return [];
  }

  private _validate_environment(payload: Record<string, unknown>): string[] {
    try {
      EnvironmentSpec.from_dict(payload);
    } catch (exc) {
      if (exc instanceof GraphDefinitionError) {
        return this._violations('environment 补丁非法', exc);
      }
      throw exc;
    }
    return [];
  }

  private _validate_artifact(payload: Record<string, unknown>): string[] {
    const artifactId = payload['artifact_id'];
    const kind = payload['kind'];
    const hashes = payload['hashes'];
    const violations: string[] = [];
    if (!artifactId || typeof artifactId !== 'string') {
      violations.push('artifact 补丁缺 artifact_id（字符串）');
    }
    if (!kind || typeof kind !== 'string') {
      violations.push('artifact 补丁缺 kind（字符串）');
    }
    if (!isRecord(hashes)) {
      violations.push('artifact 补丁缺 hashes（文件 → sha256 dict）');
    } else {
      for (const [name, digest] of Object.entries(hashes)) {
        if (typeof name !== 'string' || typeof digest !== 'string') {
          violations.push(`artifact 哈希声明非法: ${pyRepr(name)} → ${pyRepr(digest)}`);
          continue;
        }
        if (digest.length !== 64) {
          violations.push(
            `artifact 文件 ${name} 的哈希须为 sha256 hex（64 字符）: ${pyRepr(digest)}`,
          );
        }
      }
    }
    return violations;
  }
}
