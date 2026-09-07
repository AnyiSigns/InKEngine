/**
 * llm_decider 基础节点执行体（引擎内置：单数据节点内完成模型流式 + 工具回合）。
 *
 * 执行语义与产品 chat 图 agent 节点同构（机制零新增）：恢复消息链（缺省 =
 * 可选系统提示 + 回合输入）→ llm.astream(tools=注入工具表) 流式回复（token
 * 逐帧 reply_token）→ 累积工具调用 → 逐条经 seams.tool_pipeline 执行（守卫/
 * 审批全机制；审批挂起 = 引擎中断卡持久化，重入续跑）→ 结果以 tool 消息回灌
 * → 直至无工具调用或达 max_tool_rounds（config 覆盖，缺省引擎常量）。无模型/
 * 无流水线 = 确定性 stub 回复（无真实模型也能稳定抵达回复态）；终止决议经
 * ctx.terminate 结束本轮。消息链随 state 持久化：中断/异常重入不重复已落
 * 结果的工具（消息链含已执行工具结果）。
 *
 * 工厂闭包持 seams 盒（见 seams.ts）：llm/流水线/工具表随引擎重建刷新，
 * 节点执行时现取最新值，不携带过期闭包。
 */

import { NodeContract } from '../contracts/contracts.js';
import { GraphDefinitionError } from '../errors.js';
import { TerminateReason } from '../graph/graph_types.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../schema/schemaValidator.js';
import {
  ToolCall,
  accumulate_tool_calls,
  assistant,
  system,
  tool_result,
  user,
  Attachment,
  Message,
} from '../llm/messages.js';
import type { AsyncLLM } from '../llm/_guard_types.js';
import type { ToolPipeline } from '../tool_pipeline/tool_pipeline.js';
import type { ToolSpec } from '../llm/tools.js';
import type { NodeFactory } from '../registry/registry_types.js';
import {
  ENGINE_DEFAULT_TOOL_ROUNDS,
  ENGINE_STUB_REPLY,
  STATE_MESSAGES,
  STATE_REPLY,
  STATE_TOOL_ROUNDS,
} from './constants.js';
import { type EngineNodeSeams, type _EngineNodeSeamsBox } from './seams.js';

/** 消息链/附件的持久化 JSON 形态（随 state 持久化，重入续跑防重复执行）。 */
type StoredMessage = Record<string, unknown>;

/** 节点运行时上下文的消费面（执行器注入的结构超集；声明自己消费的最小面）。 */
interface _DeciderCtx {
  state: Record<string, unknown>;
  thread_id?: string;
  emit(etype: string, payload: Record<string, unknown>, opts?: { step_id?: string | null }): Promise<void>;
  terminate?(reason: string, meta?: Record<string, unknown>): void;
  account_usage?(usage: Record<string, unknown> | null): void;
  canary_active?: boolean;
}

/** 回合工具上限解析（config 缺省引擎常量；防失控循环，域 1..200）。 */
function _round_cap(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(200, Math.max(1, Math.trunc(raw)));
  }
  return ENGINE_DEFAULT_TOOL_ROUNDS;
}

/** 归一会话附件载荷为引擎 Attachment（经数据面 dict 直构）。 */
function _toAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw) {
    try {
      out.push(Attachment.from_dict(item as Record<string, unknown> as never));
    } catch {
      // 载荷经宿主归一层已滤非法项；此处兜底跳过不击穿回合
    }
  }
  return out;
}

/** 消息 JSON → Message（持久化形态回读；非法跳过防击穿）。 */
function _messageFrom(record: StoredMessage): Message | null {
  try {
    return Message.from_dict(record as never);
  } catch {
    return null;
  }
}

/** 恢复或初始化回合消息链（user 首轮输入始终注入；续链沿用已持久化链）。 */
function _seedMessages(
  state: Record<string, unknown>,
  input: string,
  attachments: Attachment[],
  system_prompt: string,
): Message[] {
  const stored = Array.isArray(state[STATE_MESSAGES])
    ? (state[STATE_MESSAGES] as StoredMessage[])
        .map(_messageFrom)
        .filter((message): message is Message => message !== null)
    : [];
  if (stored.length > 0) return stored;
  const seeded: Message[] = [];
  if (system_prompt !== '') seeded.push(system(system_prompt));
  if (input !== '' || attachments.length > 0) {
    seeded.push(user(input, { attachments }));
  } else {
    seeded.push(user(''));
  }
  state[STATE_MESSAGES] = seeded.map((message) => message.to_dict());
  return seeded;
}

/** 工具参数 JSON 解析（ToolCall.arguments 为序列化 JSON 文本）。 */
function _parse_tool_args(call: ToolCall): Record<string, unknown> {
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
async function _stream_turn(
  llm: AsyncLLM,
  ctx: _DeciderCtx,
  messages: readonly Message[],
  specs: readonly ToolSpec[],
  name: string,
): Promise<{ text: string; calls: ToolCall[] }> {
  const parts: string[] = [];
  const deltas: unknown[] = [];
  const tools = specs.length > 0 ? [...specs] : null;
  for await (const chunk of llm.astream(messages, { tools, params: null })) {
    if (chunk.usage !== null && chunk.usage !== undefined && typeof ctx.account_usage === 'function') {
      ctx.account_usage(chunk.usage);
    }
    if (chunk.token) {
      parts.push(chunk.token);
      const payload: Record<string, unknown> = { token: chunk.token };
      if (name !== '') payload['name'] = name;
      await ctx.emit('reply_token', payload);
    }
    if (chunk.tool_calls_delta) deltas.push(...chunk.tool_calls_delta);
  }
  const calls = accumulate_tool_calls(deltas as never);
  return { text: parts.join(''), calls };
}

/** 执行一条工具调用（ToolPipeline 统一守卫；非 ok 走 round 错误/终止）。
 *  返回 false = 终止决议（调用方停止后续工具执行，本轮结束）。 */
async function _execute_tool(
  pipeline: ToolPipeline,
  ctx: _DeciderCtx,
  spec: ToolSpec,
  call: ToolCall,
): Promise<{ output: string; halt: boolean }> {
  const args = _parse_tool_args(call);
  const result = await pipeline.execute(ctx as never, spec, args);
  if (!result.ok) {
    if (result.decision === 'terminate') {
      if (typeof ctx.terminate === 'function') {
        ctx.terminate(TerminateReason.STOP, { tool: spec.name });
      }
      return { output: '', halt: true };
    }
    throw new Error(
      `工具 ${spec.name} 执行未通过（${result.decision}）: ${result.error ?? '无原因'}`,
    );
  }
  return { output: result.output ?? '', halt: false };
}

/** 当前注入工具表（seams 线程化读取器优先；缺省回落静态清单）。 */
function _current_specs(seams: EngineNodeSeams, ctx: _DeciderCtx): readonly ToolSpec[] {
  if (typeof seams.collect_specs === 'function') {
    return seams.collect_specs(ctx.thread_id);
  }
  return seams.tool_specs;
}

/** llm_decider 契约：读消息链/回合输入，产出 reply（安全档 0）。 */
export function llm_decider_contract(): NodeContract {
  return new NodeContract({
    input_schema: null,
    output_schema: new SchemaSpec({
      name: 'llm_decider.output',
      fields: [new SchemaField({ name: STATE_REPLY, required: true, kind: FIELD_STRING })],
    }),
    safety_tier: 0,
    version: 1,
  });
}

/** llm_decider 工厂：seams 盒 → 节点工厂（配置 → 节点执行函数）。 */
export function make_llm_decider_factory(box: _EngineNodeSeamsBox): NodeFactory {
  return (config: Record<string, unknown>) => {
    const system_prompt = String(config['system_prompt'] ?? '');
    const max_rounds = _round_cap(config['max_tool_rounds']);
    const node_name = String(config['name'] ?? '');

    return async (raw: unknown): Promise<Record<string, unknown> | null> => {
      const seams = box.current;
      const ctx = raw as _DeciderCtx;
      const llm = seams.llm;
      const pipeline = seams.tool_pipeline;
      const input = String(ctx.state['input'] ?? '');
      if (llm === null || pipeline === null) {
        await ctx.emit('reply_token', { token: ENGINE_STUB_REPLY });
        return { [STATE_REPLY]: ENGINE_STUB_REPLY };
      }
      const messages = _seedMessages(
        ctx.state,
        input,
        _toAttachments(ctx.state['attachments']),
        system_prompt,
      );
      let rounds = 0;
      while (rounds < max_rounds) {
        rounds += 1;
        const specs = _current_specs(seams, ctx);
        const turn = await _stream_turn(llm, ctx, messages, specs, node_name);
        messages.push(
          assistant(turn.text, { tool_calls: turn.calls.length > 0 ? turn.calls : null, name: node_name || null }),
        );
        ctx.state[STATE_MESSAGES] = messages.map((message) => message.to_dict());
        if (turn.calls.length === 0) {
          const reply = turn.text.trim() === '' ? ENGINE_STUB_REPLY : turn.text;
          ctx.state[STATE_REPLY] = reply;
          return {
            [STATE_REPLY]: reply,
            [STATE_MESSAGES]: messages.map((message) => message.to_dict()),
            [STATE_TOOL_ROUNDS]: 0,
          };
        }
        ctx.state[STATE_TOOL_ROUNDS] = rounds;
        const specByName = new Map(specs.map((spec) => [spec.name, spec]));
        let halted = false;
        for (const call of turn.calls) {
          const spec = specByName.get(call.name);
          if (spec === undefined) {
            throw new GraphDefinitionError(`llm_decider 请求调用未知工具: ${call.name}`);
          }
          const outcome = await _execute_tool(pipeline, ctx, spec, call);
          if (outcome.halt) {
            halted = true;
            break;
          }
          messages.push(tool_result(outcome.output, call.id));
          ctx.state[STATE_MESSAGES] = messages.map((message) => message.to_dict());
        }
        if (halted) {
          return {
            [STATE_REPLY]: '',
            [STATE_MESSAGES]: messages.map((message) => message.to_dict()),
            [STATE_TOOL_ROUNDS]: 0,
          };
        }
      }
      throw new Error(`llm_decider 工具回合超限（>${max_rounds} 轮）`);
    };
  };
}
