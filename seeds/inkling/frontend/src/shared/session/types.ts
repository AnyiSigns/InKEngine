/**
 * InKling 消息与事件契约类型（与 seed_data/event_types.json 数据形态对齐）。
 *
 * 消息流 = 引擎回合事件在会话侧落位后的可渲染形态；事件 = 绑定协议
 * events.* 通道的原始负载。组件只消费这里声明的形态，不感知传输细节。
 */

/** 消息身份：stepId 回合内唯一，roundId 为回合归属（跨回合同名 stepId 互不干扰）。 */
export interface InkMessageBase {
  id: string;
  roundId?: string;
  stepId?: string;
}

/** 用户/助手正文消息。 */
export interface InkTextMessage extends InkMessageBase {
  kind: 'text';
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** 流式回复段（reply_token 事件累积写入，commit 后定型为 text/assistant）。 */
export interface InkStreamingMessage extends InkMessageBase {
  kind: 'streaming';
  content: string;
}

/** 思考过程（thinking_start/thinking_end 事件对）。 */
export interface InkThinkingMessage extends InkMessageBase {
  kind: 'thinking';
  content: string;
  status: 'running' | 'completed';
}

/** 规划/重规划（plan_start/plan_end）。 */
export interface InkPlanMessage extends InkMessageBase {
  kind: 'plan';
  content: string;
  status: 'running' | 'completed';
  workflow?: string;
}

/**
 * 工具调用内联行（tool_start/tool_end）——消息流机制内联形态：
 * 工具名 · 权限判定 · 结果摘要，单行展示不展开。
 */
export interface InkToolMessage extends InkMessageBase {
  kind: 'tool';
  tool: string;
  permission: string;
  toolStatus: 'running' | 'done' | 'error' | 'pending';
  summary?: string;
}

/** 子任务展开（spawn_start/spawn_end）。 */
export interface InkSpawnMessage extends InkMessageBase {
  kind: 'spawn';
  nodeId?: string;
  status: 'running' | 'completed' | 'failed';
  label?: string;
  reason?: string;
}

/** 设备感知/控制留痕内联行（events.*device*）。 */
export interface InkDeviceMessage extends InkMessageBase {
  kind: 'device';
  action: string;
  detail?: string;
}

/** 检索命中/孵化信号内联微卡（knowledge_row 领域组件数据源）。 */
export interface InkKnowledgeHitMessage extends InkMessageBase {
  kind: 'knowledge_hit';
  hits: Array<{ id: string; title: string; snippet: string }>;
}

/** 审批卡（review_card 事件负载，live=true 可操作）。 */
export interface InkReviewCardMessage extends InkMessageBase {
  kind: 'review_card';
  payload: Record<string, unknown>;
  live: boolean;
}

/** 建议（suggestions 事件）。 */
export interface InkSuggestionsMessage extends InkMessageBase {
  kind: 'suggestions';
  items: string[];
}

/** 错误（error 事件）。 */
export interface InkErrorMessage extends InkMessageBase {
  kind: 'error';
  content: string;
}

/** 未注册事件类型的折叠兜底（展示原始 JSON，回放不崩）。 */
export interface InkUnknownMessage extends InkMessageBase {
  kind: 'unknown';
  token: string;
}

export type InkMessage =
  | InkTextMessage
  | InkStreamingMessage
  | InkThinkingMessage
  | InkPlanMessage
  | InkToolMessage
  | InkSpawnMessage
  | InkDeviceMessage
  | InkKnowledgeHitMessage
  | InkReviewCardMessage
  | InkSuggestionsMessage
  | InkErrorMessage
  | InkUnknownMessage;

/** 回合步骤快照（state.round_steps 通道：来源明细/演化时间线消费）。 */
export interface RoundStep {
  stepId: string;
  type: string;
  label?: string;
  status?: string;
  note?: string;
  startedAt: number;
  elapsedMs?: number;
  tokens?: number;
  meta?: Record<string, unknown>;
}

/** 模型挡位（router/tool/main/audit）与模式档提示（agent_input 底部小字）。 */
export type GearTier = 'router' | 'tool' | 'main' | 'audit';
export type ModeTier = 'default' | 'observe' | 'review' | 'sandbox';

/** 推演轨迹（simulate_decision 分支对比 + swap_branch 换选）。 */
export interface SimulationBranch {
  branchId: string;
  label: string;
  score: number;
  rationale?: string;
  steps: Array<{ node: string; status: string; note?: string }>;
  selected?: boolean;
}

/** 孵化流水（信号 → 蒸馏 → 闸门）。 */
export interface IncubationEntry {
  id: string;
  signal: string;
  signalType: string;
  stage: 'signal' | 'distilling' | 'distilled' | 'gating' | 'passed' | 'blocked';
  verdict?: string;
  gateLevel?: string;
  distilled?: string;
  createdAt: number;
}

/** 补丁链条目（演化时间线：数据源 = inspect_* 五元快照）。 */
export interface PatchChainEntry {
  patchId: string;
  kind: string;
  title: string;
  status: 'proposed' | 'applied' | 'reverted';
  level?: string;
  appliedAt?: number;
  revertedAt?: number;
  revertReason?: string;
}

/** 来源留痕（检索/记忆/证据）。 */
export interface SourceTraceEntry {
  id: string;
  sourceType: 'retrieval' | 'memory' | 'evidence' | 'device';
  title: string;
  detail?: string;
  knowledgeId?: string;
  createdAt: number;
}
