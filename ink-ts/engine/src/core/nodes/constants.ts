/**
 * 引擎内置基础节点类型的声明式常量（类型名/条件名/状态通道键/护栏默认值）。
 *
 * 类型名与旧产品数据图（回合图 / 协作者子图）约定对齐：数据图/池种子按
 * 类型名引用即解析执行——类型名是不透明字符串，注册表不解释含义。
 */

// ── 节点类型名 ──
/** LLM 决策节点：单节点内完成模型流式 + 工具回合（见 llm_decider.ts）。 */
export const TYPE_LLM_DECIDER = 'llm_decider';
/** 工具流水线节点：消费 state.pending 待执行清单；role=terminal 为终态。 */
export const TYPE_TOOL_PIPELINE = 'tool_pipeline';
/** 路由判断节点：LLM 从候选目标中选一个走向（模糊/复杂判断，占一个执行步）。 */
export const TYPE_ROUTER_JUDGE = 'router_judge';

// ── P4.2a-3 出厂可区分 llm 实例类型键（executor 绑定 engine:llm_decider；
//    各自经 config_defaults 的 output_field/read_fields 分化数据通道面）──
/** 计划制定实例：产出 plan（output_field=plan）。 */
export const TYPE_LLM_PLANNER = 'llm_planner';
/** 计划评审实例：读 plan 产出 review（read_fields=[plan]；output_field=review）。 */
export const TYPE_LLM_REVIEWER = 'llm_reviewer';
/** 主答复实例：读 plan+review 产出 reply（read_fields=[plan,review]）。 */
export const TYPE_LLM_MAIN = 'llm_main';
/** 计划后路由实例：读 plan 判断直接答复还是需补研究（read_fields=[plan]）。 */
export const TYPE_ROUTER_PLAN_JUDGE = 'router_plan_judge';

/** agent 展开执行体（kind=agent；图内 agent 结点 config 携带实体引用
 *  entity_id，执行 = 从实体目录取 EntitySpec → 展开内部子回路）。 */
export const TYPE_AGENT = 'agent';

// ── 结点 kind（§2.1 六类；类型名仍是不透明字符串）──
export const NODE_KIND_LLM = 'llm';
export const NODE_KIND_TOOL = 'tool';
export const NODE_KIND_ROUTER = 'router';
export const NODE_KIND_ENTRY = 'entry';
export const NODE_KIND_END = 'end';
export const NODE_KIND_AGENT = 'agent';

/** 结点 flags（terminal=终态候选 / loop=可回环；仅 true 语义有效）。 */
export interface NodeFlags {
  terminal?: boolean;
  loop?: boolean;
}

/** 内置基础节点类型元数据（类型名 → kind/label/description/flags）。 */
export interface EngineNodeTypeMeta {
  type: string;
  kind: string;
  label: string;
  description: string;
  flags?: NodeFlags;
}

/**
 * 引擎内置基础节点类型元数据表（池种子/池读面/类型目录共享的单一声明；
 * 只描述类别与展示元数据，执行语义仍由类型名对应的执行体承载）。
 */
export const ENGINE_NODE_TYPE_META: Readonly<Record<string, EngineNodeTypeMeta>> = {
  [TYPE_LLM_DECIDER]: {
    type: TYPE_LLM_DECIDER,
    kind: NODE_KIND_LLM,
    label: 'LLM 决策',
    description: '单节点内完成模型流式 + 工具回合',
    flags: { terminal: true },
  },
  [TYPE_LLM_PLANNER]: {
    type: TYPE_LLM_PLANNER,
    kind: NODE_KIND_LLM,
    label: '计划制定',
    description: '把会话目标拆解为执行计划并写入 plan（供下游评审/主答复消费）',
    flags: {},
  },
  [TYPE_LLM_REVIEWER]: {
    type: TYPE_LLM_REVIEWER,
    kind: NODE_KIND_LLM,
    label: '计划评审',
    description: '读取 plan 产出评审意见写入 review（读面=plan）',
    flags: {},
  },
  [TYPE_LLM_MAIN]: {
    type: TYPE_LLM_MAIN,
    kind: NODE_KIND_LLM,
    label: '综合答复',
    description: '读取 plan+review 综合产出最终 reply（读面=plan+review）',
    flags: {},
  },
  [TYPE_TOOL_PIPELINE]: {
    type: TYPE_TOOL_PIPELINE,
    kind: NODE_KIND_TOOL,
    label: '工具流水线',
    description: '消费 state.pending 工具清单；role=terminal 为终态',
    flags: {},
  },
  [TYPE_ROUTER_JUDGE]: {
    type: TYPE_ROUTER_JUDGE,
    kind: NODE_KIND_ROUTER,
    label: '路由判断',
    description: 'LLM 从候选目标中选一个走向（模糊/复杂判断，占一个执行步骤）',
    // 不作为终态：router 是图内走向分岔节点，回合收口仍由其后置终态/回复节点表达
    flags: {},
  },
  [TYPE_ROUTER_PLAN_JUDGE]: {
    type: TYPE_ROUTER_PLAN_JUDGE,
    kind: NODE_KIND_ROUTER,
    label: '计划后路由',
    description: '读取 plan 判断直接答复还是需补充研究（读面=plan；route 走向分岔）',
    flags: {},
  },
  [TYPE_AGENT]: {
    type: TYPE_AGENT,
    kind: NODE_KIND_AGENT,
    label: '实体协作者',
    description: '按 entity_id 展开实体子回路（persona 引导 + per-scope model），产出并入父状态',
    flags: {},
  },
  'vision_perceive': {
    type: 'vision_perceive',
    kind: NODE_KIND_TOOL,
    label: '视觉感知',
    description: '截图→结构化描述',
  },
};

// ── llm_decider 回环条件边名（旧数据图边声明引用；判定见 register）──
export const COND_LLM_PENDING = 'llm.pending_nonempty';
export const COND_LLM_FINISHED = 'llm.pending_empty';

// ── router_judge 走向条件族（条件名 = `route:<key>`，注册表不解释含义）──
/** route 条件族名前缀（条件边数据声明按 `route:<key>` 引用；判定见 register）。 */
export const COND_ROUTE_PREFIX = 'route:';

/** 组装单个 route 走向条件名（key 合法性校验由注册面以 GraphDefinitionError 拒绝）。 */
export function route_condition_name(key: string): string {
  return `${COND_ROUTE_PREFIX}${key}`;
}

// ── 状态通道键（节点间共享的状态面；数据图/池种子按名引用）──
export const STATE_MESSAGES = 'messages';
export const STATE_DISPLAY_MESSAGES = 'display_messages';
export const STATE_DISPLAY_SEQ = 'display_seq';
export const STATE_PENDING = 'pending';
export const STATE_REPLY = 'reply';
/** llm_planner 产出键（output_field=plan；供 reviewer/main 只读投影消费）。 */
export const STATE_PLAN = 'plan';
/** llm_reviewer 产出键（output_field=review；供 main 只读投影消费）。 */
export const STATE_REVIEW = 'review';
export const STATE_TOOL_ROUNDS = 'tool_rounds';
export const STATE_RESULTS = 'results';
export const STATE_STEP_ARGS = 'step_args';
/** router 走向决议（router_judge 写入选中的候选 key；`route:<key>` 条件边据此判定）。 */
export const STATE_ROUTE_TO = '_route_to';

// ── 护栏默认值（config 缺省；宿主/数据图可覆盖）──
/** 工具回合上限（单数据节点内模型决策循环轮数；防成本失控）。 */
export const ENGINE_DEFAULT_TOOL_ROUNDS = 8;
/** 终态 role（tool_pipeline 配置 role='terminal' = 图出口终态实例）。 */
export const ROLE_TERMINAL = 'terminal';

/** 工具回合上限统一钳制（声明/config 覆写入口；域 1..200，非法 = 引擎常量缺省）。 */
export function clamp_tool_rounds(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(200, Math.max(1, Math.trunc(raw)));
  }
  return ENGINE_DEFAULT_TOOL_ROUNDS;
}

/** 确定性 stub 回复（无模型兜底；无真实模型也能稳定抵达回复态）。 */
export const ENGINE_STUB_REPLY = '（模型未装配，引擎确定性回复）';
