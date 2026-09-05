/**
 * harness 注册表（harness.py 移植：进程内运行时视图）。
 *
 * 注册 = 插拔 U 盘：登记定义即可用（路由/建图/工具清单一条路径），同名
 * 重复注册 = 覆盖（宿主按配置装配，配置驱动）；注销 = 显式退役（存在则
 * 移除、不存在静默幂等——HARNESS 回退时清理运行期登记位，防只增不减）。
 *
 * 集内激活（route）：任务描述 → 集内相关度激活清单（相关度降序、阈值
 * 过滤）——作用域 = 用户集（本注册表即集内视图），无跨集选择、无路由
 * 误匹配；未命中 = 集内无承接该任务的能力包，由调用方决定询问用户或走
 * 默认 harness——引擎只做相关度排序，不替宿主做选择。
 *
 * 注册即校验：图定义/工具定义/默认编排模板在注册期可解析（LLM 生成定义
 * 的入口，非法定义在注册期暴露而非执行期静默降级）。本文件同时承载默认
 * 匹配器 _keyword_match（确定性、零 LLM 调用；宿主可注入自定义匹配器）。
 */
import {
  DeclarativeToolExecutors,
  DeclarativeToolSpec,
  build_declarative_pipeline,
} from '../declarative_tools/index.js';
import { GraphDefinitionError } from '../errors.js';
import { Graph } from '../graph/graph.js';
import type { ToolSpec } from '../llm/tools.js';
import type { NetworkPolicy } from '../permissions/networkPolicy.js';
import { Plan } from '../plan/plan.js';
import { GraphRegistries } from '../registry/registry.js';
import { StateSchema } from '../state/schema.js';
import { DEFAULT_MAX_RESULT_CHARS } from '../tool_pipeline/tool_pipeline.js';
import type { ToolPipeline } from '../tool_pipeline/tool_pipeline.js';
import type {
  AuditSink,
  GateSeam,
  Guard,
  SandboxSeam,
  TraceSink,
} from '../tool_pipeline/_types.js';
import { _keyword_match } from './builder.js';
import { DEFAULT_ROUTE_THRESHOLD, HarnessDefinition } from './definition.js';
import type { CapabilityMatcher } from './definition.js';

export type { CapabilityMatcher };

/** HarnessRegistry 构造选项。 */
export interface HarnessRegistryOptions {
  registries?: GraphRegistries;
  matcher?: CapabilityMatcher;
  declarative?: DeclarativeToolExecutors;
}

/** build_pipeline 注入选项（镜像 Python build_pipeline kw-only 参数）。 */
export interface HarnessBuildPipelineOptions {
  /** 权限门禁（缺省 = 按默认拒绝策略 fail-closed 兜底）。 */
  gate?: GateSeam | null;
  /** 沙箱守卫清单（白名单与资源绑定归宿主注入）。 */
  sandboxes?: readonly SandboxSeam[];
  /** 网络策略（http_fetch 经网络守卫；null = 不接入网络守卫）。 */
  network_policy?: NetworkPolicy | null;
  /** 白名单外域名处置（"review" = 转审批 / "deny" = 硬拒）。 */
  network_unlisted_policy?: string;
  /** 单调守卫清单。 */
  guards?: readonly Guard[];
  /** 审计钩子。 */
  audit?: AuditSink | null;
  /** 结果观察截断上限。 */
  max_result_chars?: number;
  /** 工具轨迹回调。 */
  trace_sink?: TraceSink | null;
}

/**
 * harness 注册表（进程内运行时视图：按名取定义/能力路由/图与工具重建）。
 */
export class HarnessRegistry {
  readonly registries: GraphRegistries;
  readonly matcher: CapabilityMatcher;
  /** 声明式工具执行体注册表（端点执行体 + 定义登记）：build_tools 登记
   *  定义，build_pipeline 装配全流水线（执行体由宿主 register 注入）。 */
  readonly declarative: DeclarativeToolExecutors;
  /** 注册表条目（Python 惯例：下划线前缀 = 内部，测试/诊断可读）。 */
  readonly _definitions: Map<string, HarnessDefinition>;

  constructor(options: HarnessRegistryOptions = {}) {
    this.registries = options.registries ?? new GraphRegistries();
    this.matcher = options.matcher ?? _keyword_match;
    this.declarative = options.declarative ?? new DeclarativeToolExecutors();
    this._definitions = new Map();
  }

  /** 登记定义（同名 = 覆盖；注册即校验图/工具/默认编排模板数据形态）。 */
  register(definition: HarnessDefinition): void {
    if (!definition.name) {
      throw new Error('harness 名不能为空');
    }
    // 注册即校验数据形态：图定义/工具定义/默认编排模板必须可解析
    // （LLM 生成定义的入口，非法定义在注册期暴露而非执行期静默降级）
    let parsed_graph: Graph | null = null;
    if (definition.graph !== null) {
      if (!definition.graph || typeof definition.graph !== 'object' || Array.isArray(definition.graph)) {
        throw new GraphDefinitionError(
          `harness ${definition.name} 的 graph 定义非法: 期望 dict`,
        );
      }
      parsed_graph = Graph.from_dict(definition.graph, {
        registry: this.registries.nodes,
        edge_registry: this.registries.edges,
        validate: true,
      });
    }
    for (const tool_data of definition.tools) {
      DeclarativeToolSpec.from_dict(tool_data); // 构造即校验
    }
    if (definition.default_plan !== null) {
      if (parsed_graph === null) {
        throw new GraphDefinitionError(
          `harness ${definition.name} 的默认编排模板要求 graph 定义` +
            '（计划节点须落在可执行图上）',
        );
      }
      Plan.parse(definition.default_plan, {
        graph: parsed_graph,
        edge_registry: this.registries.edges,
        policy: 'loose',
      });
    }
    this._definitions.set(definition.name, definition);
  }

  /**
   * 注销 harness 定义（存在则移除，不存在静默幂等）。
   *
   * 注销原语与注册对称：注册→注销→再注册可用（回退 = 注销当前定义 +
   * 重新登记旧版本）；重复注销不报错（幂等）。声明式工具定义登记
   * （build_tools 的副作用）随注销批量清理——按该 harness 的工具名逐条
   * declarative.unregister_definition（build_tools 再注册时重新登记，
   * 与「注册→注销→再注册」对称语义一致）。
   */
  unregister(name: string): void {
    const definition = this._definitions.get(name);
    if (definition === undefined) return;
    for (const tool_data of definition.tools) {
      const toolName = (tool_data as { name?: unknown }).name;
      if (typeof toolName === 'string' && toolName !== '') {
        this.declarative.unregister_definition(toolName);
      }
    }
    this._definitions.delete(name);
  }

  /** 按名取定义（未注册 = null）。 */
  get(name: string): HarnessDefinition | null {
    return this._definitions.get(name) ?? null;
  }

  /** 已注册 harness 名清单（插入序）。 */
  names(): readonly string[] {
    return [...this._definitions.keys()];
  }

  /**
   * 集内激活：任务描述 → 集内相关度激活清单（相关度降序，阈值过滤）。
   *
   * 作用域 = 用户集（本注册表即集内视图）：任务只在集内按相关度裁剪，
   * 无跨集选择、无路由误匹配。未命中（空清单）= 集内无承接该任务的能力
   * 包，由调用方决定询问用户或走默认 harness。
   *
   * @returns [harness 名, 相关度] 清单（按相关度降序，>= threshold 才入列）。
   */
  route(task: string, options: { threshold?: number } = {}): Array<[string, number]> {
    const threshold = options.threshold ?? DEFAULT_ROUTE_THRESHOLD;
    const scored: Array<[string, number]> = [];
    for (const [name, definition] of this._definitions) {
      scored.push([name, this.matcher(task, definition)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.filter(([, score]) => score >= threshold);
  }

  /**
   * 按定义重建可执行图（图定义数据 → 注册表解析的函数节点图）。
   *
   * @returns Graph：可交予引擎编译执行；定义无图（纯工具 harness）返回 null。
   * @throws Error 未注册 harness 时（镜像 Python KeyError 语义）。
   */
  build_graph(name: string): Graph | null {
    const definition = this._definitions.get(name);
    if (definition === undefined) {
      throw new Error(`harness 未注册: ${name}`);
    }
    if (definition.graph === null) return null;
    return Graph.from_dict(definition.graph, {
      registry: this.registries.nodes,
      edge_registry: this.registries.edges,
      validate: true,
    });
  }

  /**
   * 按定义还原状态通道 schema（null = 无 schema，走引擎默认）。
   * @throws Error 未注册 harness 时（镜像 Python KeyError 语义）。
   */
  build_schema(name: string): StateSchema | null {
    const definition = this._definitions.get(name);
    if (definition === undefined) {
      throw new Error(`harness 未注册: ${name}`);
    }
    return StateSchema.from_dict(definition.schema);
  }

  /**
   * 按定义还原工具清单（声明式工具定义 → 引擎工具描述，含定义期校验）。
   *
   * 登记副作用：定义登记进声明式执行体注册表（执行体分发反查）——
   * build_tools 后该 harness 的声明式工具即可经 build_pipeline 走完整
   * 执行流水线。
   *
   * @throws Error 未注册 harness 时（镜像 Python KeyError 语义）。
   */
  build_tools(name: string): ToolSpec[] {
    const definition = this._definitions.get(name);
    if (definition === undefined) {
      throw new Error(`harness 未注册: ${name}`);
    }
    const specs: ToolSpec[] = [];
    for (const tool_data of definition.tools) {
      const declarative = DeclarativeToolSpec.from_dict(tool_data);
      this.declarative.register_definition(declarative);
      specs.push(declarative.to_spec());
    }
    return specs;
  }

  /**
   * 构建 harness 声明式工具的完整执行流水线（轻路径接线）。
   *
   * 登记定义 + 装配 extractor（端点类型操作推导）与 executor（端点执行体
   * 分发）——声明式工具经此走全流水线（门禁 → 沙箱 → 守卫 → 审批 →
   * 审计）。门禁默认 fail-closed（未注入时按默认拒绝策略兜底），沙箱/守卫
   * 由宿主注入；传入 network_policy 时 http_fetch 经网络守卫（unlisted
   * policy = review 档白名单外域名转审批 / deny 档硬拒）；判定目标推导
   * 失败恒 fail-closed 拒绝。
   *
   * @throws Error 未注册 harness 时（镜像 Python KeyError 语义）。
   */
  build_pipeline(name: string, options: HarnessBuildPipelineOptions = {}): ToolPipeline {
    this.build_tools(name);
    return build_declarative_pipeline(this.declarative, {
      gate: options.gate ?? null,
      sandboxes: options.sandboxes ?? [],
      network_policy: options.network_policy ?? null,
      network_unlisted_policy: options.network_unlisted_policy ?? 'review',
      guards: options.guards ?? [],
      audit: options.audit ?? null,
      max_result_chars: options.max_result_chars ?? DEFAULT_MAX_RESULT_CHARS,
      trace_sink: options.trace_sink ?? null,
    });
  }
}
