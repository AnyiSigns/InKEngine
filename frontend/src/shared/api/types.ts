/** 引擎/宿主共享的类型契约（Agent 对话域）。 */

/** 回合步骤序列（历史回放数据：步骤为展示事件的顺序数组）。 */
export interface RoundStepRecord {
  step_id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface AgentRound {
  id: number;
  round_id: string;
  steps: RoundStepRecord[];
  checkpoint_id?: string | null;
  created_at?: string | null;
}

export interface AgentRoundStepsResponse {
  rounds: AgentRound[];
  /** 最近一条未完成回合（弹卡挂起/断线重连渲染源） */
  pending: { round_id: string; steps: RoundStepRecord[] } | null;
  /** 会话有历史消息但无回合步骤（旧协议会话，不支持回放） */
  legacy: boolean;
}

/** SSE 事件契约（对齐引擎事件信封：type/step_id/round_id/payload）。 */
export interface SSEEvent {
  type:
    | 'reply_token'
    | 'thinking_start'
    | 'thinking_token'
    | 'thinking_end'
    | 'plan_start'
    | 'plan_token'
    | 'plan_end'
    | 'tool_start'
    | 'tool_end'
    | 'node_start'
    | 'node_stream'
    | 'node_end'
    | 'node_fail'
    | 'review_card'
    | 'suggestions'
    | 'memory_hit'
    | 'chapter_written'
    | 'title_update'
    | 'end'
    | 'error'
    | 'heartbeat'
    | 'regenerated_from';
  /** 展示事件回合内稳定唯一 id（工具/节点/正文段等按类计数） */
  step_id?: string;
  /** 展示事件回合归属（用户消息为回合边界） */
  round_id?: string;
  token?: string;
  /** 工具分类（entity/write/query/text，宿主映射；不泄露内部工具名） */
  category?: string;
  tool?: string;
  tool_call_id?: string;
  success?: boolean;
  node_id?: string;
  node_label?: string;
  label?: string;
  /** 节点进度（生成通道按章 N/M，内嵌于节点事件） */
  n?: number;
  total?: number;
  message?: string;
  reply?: string;
  reason?: string;
  content?: string;
  elapsed?: number;
  hits?: Array<{ id: unknown; title: string; snippet: string }>;
  tokens?: number;
  output_preview?: string;
  thread_id?: string;
  title?: string;
  summary?: string;
  chapter_id?: number;
  items?: Array<{
    type?: string;
    message?: string;
    suggestion?: string;
    severity?: string;
  }>;
  // 审核卡契约（与 pending_review 对齐）：
  // gate=写操作门控 / audit=质量审计拦截 / candidate=候选选择卡 / body=正文审批卡
  review_type?: 'gate' | 'audit' | 'candidate' | 'body';
  /** 审核卡关联的目标引用 ID（宿主语义：章节等） */
  target_id?: number;
  elapsed_ms?: number;
  /** 候选卡来源：workflow=工作流节点候选 / divergent=平行起草变体 */
  source?: 'workflow' | 'divergent';
  /** 候选选择卡负载：全量文本按候选顺序划分 */
  candidates?: Array<{ node_id: string; node_label?: string; output?: string }>;
  /** 引擎事件负载（引擎信封 payload 字段直透） */
  payload?: Record<string, unknown>;
}
