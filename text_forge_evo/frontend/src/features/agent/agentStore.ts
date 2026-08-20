
import { create } from 'zustand';

/**
 * Agent 面板独立状态 store（协议 v2）。
 *
 * 与书籍详情 store 解耦：Agent 会话/流式/步骤序列状态全部收敛于此，
 * AgentPanel 与手稿页 AgentDock 共用。
 *
 * 消息模型：stepId + roundId 精确标识（后端事件协议 v2 契约）。
 * - stepId 在回合内稳定唯一（think:1 / plan:1 / tool:<id> / node:<id> / reply:N）；
 * - roundId 为回合归属（用户消息为回合边界）；
 * - 更新按 (stepId, roundId) 精确匹配——stepId 回合内唯一，跨回合必须
 *   携带 roundId 防御（不同回合的 think:1 互不干扰）。
 */

export interface AgentStepBase {
  role: 'user' | 'assistant';
  content: string;
  /** 稳定 id：插入时生成，供消息列表 key 使用 */
  id?: string;
  /** 事件协议 v2：步骤 id（回合内唯一）；本地合成消息（用户文本/错误）可为空 */
  stepId?: string;
  /** 事件协议 v2：回合 id（用户消息为回合边界）；本地合成消息先置空，首事件到达后回填 */
  roundId?: string;
}

export interface AgentTextStep extends AgentStepBase {
  type?: 'user' | 'assistant' | 'system' | 'suggestions' | 'node-output';
  token?: string;
  label?: string;
  note?: string;
  /** 书籍锁冲突（503）错误消息携带的原始用户指令，供「解除占用并重试」使用 */
  retryMessage?: string;
}

export interface AgentStreamingStep extends AgentStepBase {
  type: 'streaming';
}

export interface AgentErrorStep extends AgentStepBase {
  type: 'error';
  retryMessage?: string;
}

export interface AgentToolStep extends AgentStepBase {
  type: 'tool';
  /** 展示分类（entity/write/query/text，后端 group_of 映射；不泄露内部工具名） */
  category?: string;
  /** 旧数据兼容：无 category 时展示回退用 */
  tool?: string;
  /** pending：门控写工具被拦截待审核（review_card 到达时置位） */
  toolStatus?: 'running' | 'done' | 'error' | 'pending';
  /** tool_call_id 配对——同轮同名工具连续调用不错位 */
  toolCallId?: string;
  toolSuccess?: boolean;
}

export interface AgentNodeStep extends AgentStepBase {
  type: 'node';
  nodeId?: string;
  nodeStatus?: 'running' | 'completed' | 'failed' | 'aborted';
  tokens?: number;
  label?: string;
  reason?: string;
  /** 节点执行中的 N/M 进度（生成通道按章，内嵌于节点事件，无独立 progress 事件） */
  progress?: { step: string; n: number; total: number; label?: string };
}

export interface AgentCardStep extends AgentStepBase {
  type: 'review-card';
  token?: string;
  /** false = 历史回放只读（不渲染操作按钮），缺省视为 live */
  live?: boolean;
}

export interface AgentRagRefStep extends AgentStepBase {
  type: 'rag-ref';
  refs: Array<{ docName: string; snippet: string }>;
}

export interface AgentUnknownStep extends AgentStepBase {
  /** 未注册事件类型的折叠兜底卡（渲染端按 token 展示原始 JSON） */
  type: 'unknown';
  token: string;
}

export interface AgentThinkingStep extends AgentStepBase {
  type: 'thinking';
  status?: 'running' | 'completed';
  memories?: Array<{ id: unknown; title: string; snippet: string }>;
}

export interface AgentPlanStep extends AgentStepBase {
  type: 'plan';
  status?: 'running' | 'completed';
  memories?: Array<{ id: unknown; title: string; snippet: string }>;
}

export type AgentStepMessage =
  | AgentTextStep
  | AgentStreamingStep
  | AgentErrorStep
  | AgentToolStep
  | AgentNodeStep
  | AgentCardStep
  | AgentThinkingStep
  | AgentPlanStep
  | AgentRagRefStep
  | AgentUnknownStep;

export type { AgentStepMessage as AgentMessage };

interface AgentStoreState {
  /** 消息流（含各类步骤卡，按插入顺序渲染） */
  messages: AgentStepMessage[];
  streaming: boolean;
  threadId: string | null;
  pendingReview: Record<string, unknown> | null;
  /** 当前活动回合 id（首个 SSE 事件到达时锁定；回合防御依据） */
  activeRoundId: string | null;
  /** 旧协议会话提示（有历史消息但无回合步骤，不支持回放） */
  legacyNotice: boolean;
  /** 已作废回合（T6 从该消息重新生成后，目标回合及其后全部回合） */
  invalidRounds: Set<string>;

  setStreaming: (v: boolean) => void;
  setThreadId: (id: string | null) => void;
  setPendingReview: (review: Record<string, unknown> | null) => void;
  setActiveRoundId: (roundId: string) => void;
  setLegacyNotice: (v: boolean) => void;
  /** T6：标记目标回合及其后全部回合为已作废（regenerated_from 事件到达时） */
  markInvalidFrom: (roundId: string) => void;

  /** 追加消息（本地合成：用户文本/错误/引用卡） */
  addMessage: (msg: AgentStepMessage) => void;
  /**
   * 按 (stepId, roundId) 精确更新步骤（协议 v2 主更新路径）。
   * 不存在时按 factory 创建；roundId 为空时跳过存在性匹配直接追加
   * （回合 id 未锁定前的乱序事件防御）。
   */
  upsertStep: (opts: {
    stepId: string;
    roundId: string;
    create: () => AgentStepMessage;
    patch?: (msg: AgentStepMessage) => AgentStepMessage;
  }) => void;
  /** 追加正文 token 到指定正文段（不存在则创建 streaming 消息） */
  appendReplyToken: (stepId: string, roundId: string, token: string) => void;
  /** 定型残留 streaming 消息：有内容转 assistant，空消息移除 */
  commitStreaming: () => void;
  /** 全量复位（会话切换/新建） */
  resetAll: () => void;
}

function nextMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function withId(msg: AgentStepMessage, stepId?: string, roundId?: string): AgentStepMessage {
  return {
    ...msg,
    id: nextMessageId(),
    ...(stepId ? { stepId } : {}),
    ...(roundId ? { roundId } : {}),
  };
}

export const useAgentStore = create<AgentStoreState>((set) => ({
  messages: [],
  streaming: false,
  threadId: null,
  pendingReview: null,
  activeRoundId: null,
  legacyNotice: false,
  invalidRounds: new Set<string>(),

  setStreaming: (v) => set({ streaming: v }),
  setThreadId: (id) => set({ threadId: id }),
  setPendingReview: (review) => set({ pendingReview: review }),
  setActiveRoundId: (roundId) =>
    set((state) => {
      if (state.activeRoundId === roundId) return {};
      // 回合锁定：回填本地合成消息（用户文本等）的 roundId
      return {
        activeRoundId: roundId,
        messages: state.messages.map((m) => (m.roundId ? m : { ...m, roundId })),
      };
    }),
  setLegacyNotice: (v) => set({ legacyNotice: v }),

  markInvalidFrom: (roundId) =>
    set((state) => {
      // 目标回合及其后全部回合作废：按消息流顺序，目标回合最后一次出现
      // 之后的回合均为其后继（消息流 = 回合顺序的天然载体）。
      // 多次重新生成取并集（union）：先对 R1 再对 R2 重生成时，R1 的失效
      // 状态不得被覆盖复活（否则旧分支消息重新以正常样式渲染造成重复）。
      const messages = state.messages;
      let targetLast = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].roundId === roundId) {
          targetLast = i;
          break;
        }
      }
      const invalid = new Set(state.invalidRounds);
      invalid.add(roundId);
      if (targetLast >= 0) {
        for (let i = targetLast + 1; i < messages.length; i++) {
          const rid = messages[i].roundId;
          if (rid) invalid.add(rid);
        }
      }
      if (invalid.size === state.invalidRounds.size) return {};
      return { invalidRounds: invalid };
    }),

  addMessage: (msg) => set((state) => ({ messages: [...state.messages, withId(msg)] })),

  upsertStep: ({ stepId, roundId, create, patch }) =>
    set((state) => {
      // 按 (stepId, roundId) 精确匹配：命中则就地 patch（事件乱序/防御性
      // 补建自然合并，不重复建卡）；未命中追加。跨回合同 stepId 互不干扰
      // （roundId 是防御键，更新永远配对匹配）。
      const messages = [...state.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.stepId !== stepId || m.roundId !== roundId) continue;
        messages[i] = patch ? patch(m) : m;
        return { messages };
      }
      return { messages: [...messages, withId(create(), stepId, roundId)] };
    }),

  appendReplyToken: (stepId, roundId, token) =>
    set((state) => {
      const messages = [...state.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.stepId !== stepId || m.roundId !== roundId) continue;
        messages[i] = {
          ...m,
          type: 'streaming',
          content: (m.content || '') + token,
        };
        return { messages };
      }
      return {
        messages: [
          ...messages,
          withId(
            { role: 'assistant', content: token, type: 'streaming' },
            stepId,
            roundId,
          ),
        ],
      };
    }),

  commitStreaming: () =>
    set((state) => {
      const messages = state.messages.map((m) => {
        if (m.type !== 'streaming') return m;
        return m.content && m.content.trim()
          ? { ...m, type: 'assistant' as const }
          : m;
      });
      return {
        messages: messages.filter(
          (m) => !(m.type === 'streaming' && !(m.content && m.content.trim())),
        ),
      };
    }),

  resetAll: () =>
    set({
      messages: [],
      streaming: false,
      pendingReview: null,
      activeRoundId: null,
      legacyNotice: false,
      invalidRounds: new Set<string>(),
    }),
}));
