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
  /** 多模态附件（user 角色携带，对齐引擎 Attachment 契约：kind + url 必备）。 */
  attachments?: OutboundAttachment[];
}

/**
 * 出站附件（与引擎 Attachment 契约对齐）：kind 分类 + 可解析 url 为必备面，
 * name/mime 为展示与诊断补充。序列化时缺 url/path 引用的附件不入载荷。
 */
export interface OutboundAttachment {
  kind: 'image' | 'video' | 'document';
  url: string;
  name?: string;
  mime?: string;
  alt?: string;
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
 * args 为原始参数（可展开，不裸 JSON 呈现为格式化区块）。
 */
export interface InkToolMessage extends InkMessageBase {
  kind: 'tool';
  tool: string;
  /**
   * 工具展示名（宿主侧经 title 通道解析：tool_start 事件载荷 title
   * 字段；渲染优先级 title → 本地词典 → label → 原始名）。
   */
  title?: string;
  permission: string;
  toolStatus: 'running' | 'done' | 'error' | 'pending';
  summary?: string;
  /** 原始参数（工具调用负载；经换行/缩进整理后供展开查看） */
  args?: string;
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

/** 审查留痕内联行（vetting_result：pass/fail/review 三态）。 */
export interface InkVettingMessage extends InkMessageBase {
  kind: 'vetting';
  tool?: string;
  verdict: 'pass' | 'fail' | 'review';
  reason?: string;
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

/**
 * 图表消息（会话流内嵌渲染）：chart spec → 自绘 SVG；
 * 不进附件流，降级渲染不崩（spec 非法/缺数据时占位卡片）。
 */
export interface InkChartMessage extends InkMessageBase {
  kind: 'chart';
  spec: import('@/shared/charts/chart_spec').ChartSpec;
}

/**
 * 图片消息（用户附件 / 引擎产出）：url/尺寸/alt 三个展示面；
 * 渲染器经媒体渲染器白名单注册（未注册渲染器拒绝渲染）。
 */
export interface InkImageMessage extends InkMessageBase {
  kind: 'image';
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  mime?: string;
}

/**
 * 视频消息：类型白名单（mp4/webm 等）+ 大小限制 + 路径白名单；
 * 超限/未知类型/越权路径均输出拒绝占位（不渲染播放器）。
 */
export interface InkVideoMessage extends InkMessageBase {
  kind: 'video';
  url: string;
  mime?: string;
  size?: number;
  title?: string;
}

/** 文档附件消息（文件选择分发的文档类：名称/大小/来源）。 */
export interface InkDocumentMessage extends InkMessageBase {
  kind: 'document';
  name: string;
  size?: number;
  url?: string;
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
  | InkVettingMessage
  | InkKnowledgeHitMessage
  | InkReviewCardMessage
  | InkSuggestionsMessage
  | InkErrorMessage
  | InkImageMessage
  | InkVideoMessage
  | InkDocumentMessage
  | InkChartMessage
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
export type GearTier = 'main' | 'router';
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
