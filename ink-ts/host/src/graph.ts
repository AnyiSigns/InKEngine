/**
 * 产品默认图配方（宿主域服务阶段定稿的内置产品图；调用方可覆写）。
 *
 * chat 图 = 单 agent 节点：装配模型（ctx.llm 守卫链）流式回复 + **工具调用
 * 回合**——tools 清单 = 配方 tool_wiring 提供的引擎统一工具面（self/
 * introspection/declarative harness，来自 ctx.tool_specs），经
 * ctx.tool_pipeline（引擎统一 ToolPipeline，含守卫/审批/沙箱语义）执行。
 * 无模型 = 确定性 stub 回复（无真实模型也能稳定抵达回复态）。
 *
 * 工具回合语义：模型产出 assistant tool_calls → 逐条经 tool_pipeline.execute
 * 执行（审批挂起 = 引擎中断卡随 checkpoint 持久化，重入后继续）→ 结果以
 * tool 消息回灌模型 → 再走一轮，直至无工具调用或达轮次上限。工具执行失败
 * （deny/error/reject）抛错走 round 错误（不静默吞）；terminate 决议走节点
 * terminate 终止。轮次上限经 options.max_tool_rounds 注入（能力记录
 * max_tool_rounds 的消费点，装配方按需传入）。
 *
 * 机制全在 engine，本文件只出图数据。
 */

import {
  Message,
  ToolCall,
  accumulate_tool_calls,
  assistant,
  system,
  tool_result,
  type Graph,
  type GraphRecipeContext,
  type ToolPipeline,
  type ToolSpec,
} from '@ink-ts/engine';
import { Attachment, Graph as GraphImpl, user } from '@ink-ts/engine';

/** 确定性 stub 回复（无模型兜底；与 cli stub 语义一致）。 */
export const STUB_REPLY = '（host 默认会话已执行）';

/** 产品默认 agent 工具回合上限（无能力记录时；防失控循环）。 */
export const PRODUCT_TOOL_ROUNDS_DEFAULT = 8;

/** 工具回合中间消息的 JSON 形态（随 state 持久化，重入续跑防重复执行）。 */
type StoredMessage = Record<string, unknown>;

interface AgentNodeCtx {
  state: Record<string, unknown>;
  emit(type: string, payload: Record<string, unknown>): Promise<void>;
  interrupt(key: string, payload: Record<string, unknown>): Promise<unknown>;
  get_interrupt_payload?(key: string): Promise<Record<string, unknown> | null>;
  terminate?(reason: string, meta?: Record<string, unknown>): void;
}

/** 工具执行上下文（engine 节点 ctx 全形态；流水线需 interrupt/emit 面）。 */
type ToolCtx = AgentNodeCtx & {
  node?: string | null;
  thread_id?: string;
};

/** 归一会话附件载荷为引擎 Attachment（经数据面 dict 直构）。 */
function toAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw) {
    try {
      out.push(Attachment.from_dict(item as Record<string, unknown> as never));
    } catch {
      // 载荷经 host 归一层已滤非法项；此处兜底跳过不击穿回合
    }
  }
  return out;
}

/** 消息 JSON → Message（持久化形态回读；非法跳过防击穿）。 */
function messageFrom(record: StoredMessage): Message | null {
  try {
    return Message.from_dict(record as never);
  } catch {
    return null;
  }
}

/** 恢复或初始化回合消息链（user 首轮输入始终注入）。 */
function seedMessages(
  state: Record<string, unknown>,
  input: string,
  attachments: Attachment[],
): Message[] {
  const stored = Array.isArray(state['_tool_messages'])
    ? (state['_tool_messages'] as StoredMessage[])
        .map(messageFrom)
        .filter((message): message is Message => message !== null)
    : [];
  const seeded: Message[] =
    stored.length > 0
      ? stored
      : [system('ink-ts host 助手'), user(input, { attachments })];
  if (state['_tool_messages'] === undefined) {
    state['_tool_messages'] = seeded.map((message) => message.to_dict());
  }
  return seeded;
}

/** 工具参数 JSON 解析（ToolCall.arguments 为序列化 JSON 文本）。 */
function parseToolArgs(call: ToolCall): Record<string, unknown> {
  let parsed: unknown = {};
  try {
    parsed = call.arguments ? (JSON.parse(call.arguments) as unknown) : {};
  } catch (error) {
    throw new Error(
      `工具 ${call.name} 参数非法（JSON 解析失败）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`工具 ${call.name} 参数须为对象`);
  }
  return parsed as Record<string, unknown>;
}

/** 单轮模型流式调用：累积文本 + 工具调用增量（reply_token 逐 token 发射）。 */
async function streamModelTurn(
  llm: NonNullable<GraphRecipeContext['llm']>,
  nodeCtx: ToolCtx,
  messages: readonly Message[],
  specs: readonly ToolSpec[],
): Promise<{ text: string; calls: ToolCall[] }> {
  const parts: string[] = [];
  const deltas: unknown[] = [];
  const tools = specs.length > 0 ? [...specs] : null;
  for await (const chunk of llm.astream(messages, { tools, params: null })) {
    if (chunk.token) {
      parts.push(chunk.token);
      await nodeCtx.emit('reply_token', { token: chunk.token });
    }
    if (chunk.tool_calls_delta) deltas.push(...chunk.tool_calls_delta);
  }
  const calls = accumulate_tool_calls(deltas as never);
  return { text: parts.join(''), calls };
}

/** 执行一条工具调用（ToolPipeline 统一守卫；非 ok 走 round 错误/终止）。 */
async function executeToolCall(
  pipeline: ToolPipeline,
  nodeCtx: ToolCtx,
  spec: ToolSpec,
  call: ToolCall,
): Promise<string> {
  const args = parseToolArgs(call);
  const result = await pipeline.execute(nodeCtx as never, spec, args);
  if (!result.ok) {
    if (result.decision === 'terminate' && nodeCtx.terminate !== undefined) {
      nodeCtx.terminate('terminate', { tool: spec.name });
      return '';
    }
    throw new Error(
      `工具 ${spec.name} 执行未通过（${result.decision}）: ${result.error ?? '无原因'}`,
    );
  }
  return result.output ?? '';
}

/**
 * 构建产品默认 chat 图（agent 节点 = 模型流式 + 工具回合）。
 *
 * @param ctx 图装配上下文（llm/tool_pipeline/tool_specs 由引擎重建注入）。
 * @param options.maxToolRounds 工具回合上限（缺省 = PRODUCT_TOOL_ROUNDS_DEFAULT；
 *   能力记录 max_tool_rounds 的装配方注入位）。
 */
export function buildProductChatGraph(
  ctx: GraphRecipeContext,
  options: { maxToolRounds?: number | null } = {},
): Graph {
  const llm = ctx.llm;
  const pipeline = ctx.tool_pipeline;
  const specs = [...ctx.tool_specs];
  const specByName = new Map(specs.map((spec) => [spec.name, spec]));
  const cap = Math.min(200, Math.max(1, Math.trunc(options.maxToolRounds ?? PRODUCT_TOOL_ROUNDS_DEFAULT)));

  const agent = async (raw: unknown): Promise<Record<string, unknown>> => {
    const nodeCtx = raw as ToolCtx;
    const input = String(nodeCtx.state['input'] ?? '');
    if (llm === null || llm === undefined || pipeline === null) {
      await nodeCtx.emit('reply_token', { token: STUB_REPLY });
      return { reply: STUB_REPLY };
    }
    const messages = seedMessages(nodeCtx.state, input, toAttachments(nodeCtx.state['attachments']));
    let rounds = 0;
    while (rounds < cap) {
      rounds += 1;
      const turn = await streamModelTurn(llm, nodeCtx, messages, specs);
      messages.push(assistant(turn.text, { tool_calls: turn.calls.length > 0 ? turn.calls : null }));
      nodeCtx.state['_tool_messages'] = messages.map((message) => message.to_dict());
      if (turn.calls.length === 0) {
        const reply = turn.text.trim() === '' ? STUB_REPLY : turn.text;
        return { reply };
      }
      for (const call of turn.calls) {
        const spec = specByName.get(call.name);
        if (spec === undefined) {
          throw new Error(`agent 请求调用未知工具: ${call.name}`);
        }
        const output = await executeToolCall(pipeline, nodeCtx, spec, call);
        messages.push(tool_result(output, call.id));
        nodeCtx.state['_tool_messages'] = messages.map((message) => message.to_dict());
      }
    }
    throw new Error(`agent 工具回合超限（>${cap} 轮）`);
  };
  const graph = new GraphImpl({ name: 'chat', entry: 'agent' });
  graph.add_node('agent', agent as never);
  graph.add_exit('agent');
  return graph;
}

/** 产品默认 chat 图配方（工具回合上限 = 产品默认值）。 */
export function productChatGraphRecipe(ctx: GraphRecipeContext): Graph {
  return buildProductChatGraph(ctx);
}
