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

// ── llm_decider 回环条件边名（旧数据图边声明引用；判定见 register）──
export const COND_LLM_PENDING = 'llm.pending_nonempty';
export const COND_LLM_FINISHED = 'llm.pending_empty';

// ── 状态通道键（节点间共享的状态面；数据图/池种子按名引用）──
export const STATE_MESSAGES = 'messages';
export const STATE_PENDING = 'pending';
export const STATE_REPLY = 'reply';
export const STATE_TOOL_ROUNDS = 'tool_rounds';
export const STATE_RESULTS = 'results';
export const STATE_STEP_ARGS = 'step_args';

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
