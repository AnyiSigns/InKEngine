/**
 * 自指层观察原语：内省数据源与常量（introspection.py 移植：数据面）。
 *
 * 观察工具是 AI 修改产品形态的前置通道——AI 先看清自己（图/规则/
 * 知识/界面/工具表），再决定提案什么补丁。本模块只负责「读」：把引擎
 * 持有的各类运行时数据整理为 JSON 快照，并以引擎工具描述（ToolSpec）
 * 注册进工具表，经标准工具流水线（权限门禁/审计/截断）执行。
 *
 * 权限形态：``introspection:read:*``（自定义域，action=read，pattern=*）。
 * 流水线判定动作固定为 (read, *)——纯只读通道，无任何外部操作目标，
 * 不触发文件/进程/网络沙箱。
 *
 * 快照皆为确定性 JSON 数据（图结构/条目清单/工具清单），不包含模型
 * 参数等运行期噪音；AI 消费快照后自行决策，引擎不做任何演化动作。
 * 快照出口统一过敏感信息剥离（security.strip_sensitive）——观察通道
 * 与落库通道同规格，凭据永不进入模型上下文。
 *
 * TS seam 差异：introspection 是对运行时对象的反射，TS 侧不反射 JS
 * 对象——实体目录等数据源以显式 seam/注册表映射表达（鸭子类型，
 * 见 EntityRegistryLike），宿主装配时注入，缺省项在快照中按空态呈现。
 */
import type { Graph } from '../graph/graph.js';
import type { HarnessRegistry } from '../harness/registry.js';
import type { KnowledgeSet } from '../knowledge_set/knowledge_set.js';
import type { ToolSpec } from '../llm/tools.js';
import { DEFAULT_MAX_RESULT_CHARS } from '../tool_pipeline/_types.js';

// 内省工具的统一权限声明（只读域；未命中默认拒绝，fail-closed）
export const INTROSPECTION_PERMISSION = 'introspection:read:*';

// 判定动作（与权限声明中的 action 配对，流水线 extractor 返回）
export const _INTROSPECTION_OPERATION = 'read';
export const _INTROSPECTION_TARGET = '*';

// 快照体积上限：知识快照默认条目数、单工具结果截断与工具 schema 声明的
// 条目上限（防超长结果挤爆上下文；限额与引擎工具流水线默认一致）
export const _DEFAULT_KNOWLEDGE_LIMIT = 20;
export const _KNOWLEDGE_LIMIT_MAX = 100;
// 单工具结果截断上限（ENG6-6：共享常量——与引擎工具流水线默认一致）
export const _MAX_RESULT_CHARS = DEFAULT_MAX_RESULT_CHARS;

/** 实体目录条目 seam（entity_registry 宿主注册表的映射形态：id/label/model
 *  引用；不含 persona 全文——目录概览保持有界）。 */
export interface EntitySpecLike {
  readonly id: string;
  readonly label: string;
  readonly model: Record<string, unknown> | null;
}

/** 实体目录注册表 seam（宿主装配注入；TS 侧不反射 JS 对象，只按端口侧
 *  Python 实体注册表的鸭子形态声明 specs() 契约）。 */
export interface EntityRegistryLike {
  specs(): readonly EntitySpecLike[];
}

/**
 * 内省数据源集合（宿主装配时注入，缺省项在快照中按空态呈现）。
 *
 * graph: 当前执行图（节点/边/出口/子图结构）；
 * knowledge_set: 用户集知识实体（规则/知识条目）；
 * harness_registry: 集内 harness 注册表（领域能力清单）；
 * tools: 当前注入面工具描述清单（保底/内省/自指 + 本会话绑定）；
 * registered_tools: 全量已注册工具描述清单（含未注入、经 request_tool
 *   可绑定的工具；缺省 = 空清单）；
 * ui_spec: 当前界面描述（JSON 布局，宿主渲染器消费；缺省 = 未定形）；
 * entity_registry: 实体目录注册表 seam（宿主注入；缺省 = null）。
 */
export class IntrospectionSources {
  graph: Graph | null = null;
  knowledge_set: KnowledgeSet | null = null;
  harness_registry: HarnessRegistry | null = null;
  tools: readonly ToolSpec[] = [];
  registered_tools: readonly ToolSpec[] = [];
  ui_spec: Record<string, unknown> | null = null;
  entity_registry: EntityRegistryLike | null = null;

  constructor(init: {
    graph?: Graph | null;
    knowledge_set?: KnowledgeSet | null;
    harness_registry?: HarnessRegistry | null;
    tools?: readonly ToolSpec[];
    registered_tools?: readonly ToolSpec[];
    ui_spec?: Record<string, unknown> | null;
    entity_registry?: EntityRegistryLike | null;
  } = {}) {
    if (init.graph !== undefined) this.graph = init.graph;
    if (init.knowledge_set !== undefined) this.knowledge_set = init.knowledge_set;
    if (init.harness_registry !== undefined) this.harness_registry = init.harness_registry;
    if (init.tools !== undefined) this.tools = init.tools;
    if (init.registered_tools !== undefined) this.registered_tools = init.registered_tools;
    if (init.ui_spec !== undefined) this.ui_spec = init.ui_spec;
    if (init.entity_registry !== undefined) this.entity_registry = init.entity_registry;
  }
}
