// gate: 超限(384 行) - llm_decider 单节点完整闭环（消息链/流式/工具回合/推理覆盖 seam 同文件，拆文件破坏执行时序可读性）
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
 * 工厂闭包持 seams 盒（见 seams.ts）：llm/流水线/工具表/boot 提示词随引擎
 * 重建刷新，节点执行时现取最新值，不携带过期闭包。
 *
 * system 消息 = boot 基线（seams.boot_system_prompt，装配注入只读）与自定义
 * system_prompt（config，用户/agent 可改）经 compose_llm_system 合成一条
 * （boot 恒前）；boot 未注入（''）= 原自定义直取行为逐字符不变（零漂移）。
 *
 * 字段 I/O 分化 config（field_io.ts 共用约定）：output_field = 回复落点状态键
 * （缺省 reply；保留键写护栏拒绝）；read_fields = 把 state 中这些键的既有内容
 * 只读投影进提示（文本段拼接，不进持久化消息链）——实例级分化（planner/
 * reviewer/main）经实例 config 生效，缺省 = 现状行为零漂移。
 */

import { NodeContract } from '../../model/contracts/contracts.js';
import { GraphDefinitionError } from '../../model/errors.js';
import { TerminateReason } from '../../model/graph/graph_types.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../model/schema/schemaValidator.js';
import {
  ToolCall,
  accumulate_tool_calls,
  assistant,
  system,
  tool_result,
  user,
  Attachment,
  Message,
} from '../../model/llm/messages.js';
import { LLMParams } from '../../dock/ports/llm.js';
import type { AsyncLLM } from '../../model/llm/_guard_types.js';
import type { ToolPipeline } from '../../loop/tools/tool_pipeline/tool_pipeline.js';
import type { ToolSpec } from '../../model/llm/tools.js';
import type { NodeFactory } from '../registry/registry_types.js';
import {
  clamp_tool_rounds,
  ENGINE_STUB_REPLY,
  STATE_MESSAGES,
  STATE_REPLY,
  STATE_ROUND_MODEL,
  STATE_TOOL_ROUNDS,
} from './constants.js';
import { type EngineNodeSeams, type _EngineNodeSeamsBox } from './seams.js';
import { compose_llm_system } from './llm_system.js';
import { build_read_projection, config_read_fields, llm_output_key } from './field_io.js';

/** 每轮模型/推理覆盖形态（宿主随回合 state 种子，见 STATE_ROUND_MODEL）。 */
interface _RoundModelOverride {
  reasoning_effort?: string;
  enable_thinking?: boolean;
  thinking_budget?: number;
}

/** 从回合 state 读每轮推理覆盖 → LLMParams（无覆盖 = null，跟随模型默认）。
 *  effort 原样携带（含 xhigh/max 等非标准档），off/关 等显式关闭也照传由
 *  adapter 按协议映射；'auto' 哨兵在此归一为 null（不注入跟随默认）。 */
function _round_reasoning_params(state: Record<string, unknown>): LLMParams | null {
  const override = state[STATE_ROUND_MODEL];
  if (override === null || typeof override !== 'object') return null;
  const record = override as _RoundModelOverride;
  const reasoning_effort =
    typeof record.reasoning_effort === 'string' && record.reasoning_effort !== ''
      ? record.reasoning_effort
      : null;
  const enable_thinking =
    typeof record.enable_thinking === 'boolean' ? record.enable_thinking : null;
  const thinking_budget =
    typeof record.thinking_budget === 'number' && record.thinking_budget > 0
      ? record.thinking_budget
      : null;
  if (reasoning_effort === null && enable_thinking === null && thinking_budget === null) {
    return null;
  }
  return new LLMParams({
    ...(reasoning_effort !== null ? { reasoning_effort } : {}),
    ...(enable_thinking !== null ? { enable_thinking } : {}),
    ...(thinking_budget !== null ? { thinking_budget } : {}),
  });
}

/** 消息链/附件的持久化 JSON 形态（随 state 持久化，重入续跑防重复执行）。 */
type StoredMessage = Record<string, unknown>;

/** 节点运行时上下文的消费面（执行器注入的结构超集；声明自己消费的最小面）。 */
interface _DeciderCtx {
  state: Record<string, unknown>;
  thread_id?: string;
  /** 子作用域模型覆盖（agent 展开注入；null/缺省 = 回落 seams 默认 llm）。 */
  scope_llm?: AsyncLLM | null;
  emit(etype: string, payload: Record<string, unknown>, opts?: { step_id?: string | null }): Promise<void>;
  terminate?(reason: string, meta?: Record<string, unknown>): void;
  account_usage?(usage: Record<string, unknown> | null): void;
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

/** 单次模型调用视图：read_fields 命中的既有状态内容以只读投影追加在消息链
 *  末尾（文本段拼接，进提示不进持久化链——投影不污染消息链语义；字段内容
 *  本身已随状态通道持久化，链上重放即得）。无命中 = 原消息链直通。 */
function _view_with_projection(
  state: Record<string, unknown>,
  messages: readonly Message[],
  read_fields: readonly string[],
): Message[] {
  const projection = build_read_projection(state, read_fields);
  if (projection === null) return [...messages];
  return [...messages, user(projection)];
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

/** 单轮模型流式调用：累积文本 + 工具调用增量（reply_token 逐 token 发射）。
 *  推理增量（reasoning_token）亦逐帧发射为 thinking_start/thinking_end 事件
 *  （前端思考卡消费：分片 content 追加、稳定 step_id 配对更新）。推理文本
 *  不写入上下文 messages（不喂模型）；展示态由事件展示聚合器从事件流派生，
 *  本节点只负责发射事件，不含展示态逻辑。 */
async function _stream_turn(
  llm: AsyncLLM,
  ctx: _DeciderCtx,
  messages: readonly Message[],
  specs: readonly ToolSpec[],
  name: string,
  think_step_id: string,
  params: LLMParams | null,
): Promise<{ text: string; calls: ToolCall[] }> {
  const parts: string[] = [];
  const deltas: unknown[] = [];
  const tools = specs.length > 0 ? [...specs] : null;
  let think_open = false;
  for await (const chunk of llm.astream(messages, { tools, params })) {
    if (chunk.usage !== null && chunk.usage !== undefined && typeof ctx.account_usage === 'function') {
      ctx.account_usage(chunk.usage);
    }
    if (chunk.reasoning_token) {
      // 首帧推理 token 才开思考卡；后续帧以分片 content 追加（前端同
      // step_id 的 thinking_start 在既有思考卡上续写）。推理文本不写入
      // 上下文 messages（不喂模型）；展示态由事件展示聚合器从事件流派生。
      if (!think_open) {
        await ctx.emit('thinking_start', { content: '', status: 'running' }, { step_id: think_step_id });
        think_open = true;
      }
      await ctx.emit('thinking_start', { content: chunk.reasoning_token, status: 'running' }, { step_id: think_step_id });
    }
    if (chunk.token) {
      parts.push(chunk.token);
      const payload: Record<string, unknown> = { token: chunk.token };
      if (name !== '') payload['name'] = name;
      await ctx.emit('reply_token', payload);
    }
    if (chunk.tool_calls_delta) deltas.push(...chunk.tool_calls_delta);
  }
  if (think_open) {
    await ctx.emit('thinking_end', { content: '', status: 'completed' }, { step_id: think_step_id });
  }
  const calls = accumulate_tool_calls(deltas as never);
  return { text: parts.join(''), calls };
}

/** 执行一条工具调用（ToolPipeline 统一守卫；非 ok 走 round 错误/终止）。
 *  返回 false = 终止决议（调用方停止后续工具执行，本轮结束）。
 *  执行前后发射 tool_start/tool_end 事件（前端工具状态卡消费；step_id 按
 *  tool_call_id 稳定，start/end 配对到同一卡）。 */
async function _execute_tool(
  pipeline: ToolPipeline,
  ctx: _DeciderCtx,
  spec: ToolSpec,
  call: ToolCall,
): Promise<{ output: string; halt: boolean }> {
  const args = _parse_tool_args(call);
  const tool_step_id = `tool:${call.id}`;
  await ctx.emit(
    'tool_start',
    { tool: spec.name, args, permission: '' },
    { step_id: tool_step_id },
  );
  const result = await pipeline.execute(ctx as never, spec, args);
  if (!result.ok) {
    await ctx.emit(
      'tool_end',
      { tool: spec.name, success: false, error: result.error ?? String(result.decision) },
      { step_id: tool_step_id },
    );
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
  await ctx.emit(
    'tool_end',
    { tool: spec.name, success: true, summary: result.output ?? '' },
    { step_id: tool_step_id },
  );
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

/** llm_decider 工厂：seams 盒 → 节点工厂（配置 → 节点执行函数）。
 *  字段 I/O 分化 config：`output_field`（回复落点状态键，缺省 reply；保留键
 *  写入拒绝）与 `read_fields`（只读投影进提示，见 field_io.ts）——缺省 =
 *  现状行为零漂移。 */
export function make_llm_decider_factory(box: _EngineNodeSeamsBox): NodeFactory {
  return (config: Record<string, unknown>) => {
    const system_prompt = String(config['system_prompt'] ?? '');
    const max_rounds = clamp_tool_rounds(config['max_tool_rounds']);
    const node_name = String(config['name'] ?? '');
    const output_field = llm_output_key(config);
    const read_fields = config_read_fields(config);

    return async (raw: unknown): Promise<Record<string, unknown> | null> => {
      const seams = box.current;
      const ctx = raw as _DeciderCtx;
      // 子作用域模型覆盖优先（agent 展开注入 scope llm）；缺省回落会话默认
      const scope_llm = ctx.scope_llm ?? null;
      const llm = scope_llm ?? seams.llm;
      const pipeline = seams.tool_pipeline;
      const input = String(ctx.state['input'] ?? '');
      if (llm === null || pipeline === null) {
        await ctx.emit('reply_token', { token: ENGINE_STUB_REPLY });
        ctx.state[output_field] = ENGINE_STUB_REPLY;
        return { [output_field]: ENGINE_STUB_REPLY };
      }
      const roundParams = _round_reasoning_params(ctx.state);
      const messages = _seedMessages(
        ctx.state,
        input,
        _toAttachments(ctx.state['attachments']),
        compose_llm_system(seams.boot_system_prompt, system_prompt),
      );
      let rounds = 0;
      while (rounds < max_rounds) {
        rounds += 1;
        const specs = _current_specs(seams, ctx);
        // 思考段 step_id 按流式轮次编号（decider 单回合内各次模型流式
        // 一段独立思考卡；前端按稳定 step_id 配对更新，不跨轮覆盖）。
        const think_step_id = `think:${rounds}`;
        const turn = await _stream_turn(
          llm,
          ctx,
          _view_with_projection(ctx.state, messages, read_fields),
          specs,
          node_name,
          think_step_id,
          roundParams,
        );
        messages.push(
          assistant(turn.text, {
            tool_calls: turn.calls.length > 0 ? turn.calls : null,
            name: node_name || null,
          }),
        );
        ctx.state[STATE_MESSAGES] = messages.map((message) => message.to_dict());
        if (turn.calls.length === 0) {
          const reply = turn.text.trim() === '' ? ENGINE_STUB_REPLY : turn.text;
          ctx.state[output_field] = reply;
          return {
            [output_field]: reply,
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
          ctx.state[output_field] = '';
          return {
            [output_field]: '',
            [STATE_MESSAGES]: messages.map((message) => message.to_dict()),
            [STATE_TOOL_ROUNDS]: 0,
          };
        }
      }
      throw new Error(`llm_decider 工具回合超限（>${max_rounds} 轮）`);
    };
  };
}
