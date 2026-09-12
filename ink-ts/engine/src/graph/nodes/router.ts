/**
 * router_judge 基础节点执行体（引擎内置：LLM 从候选目标中选一个走向）。
 *
 * 图语义定位（§2.1）：router = 图节点，占一个执行步骤，做「模糊/复杂判断选
 * 走向」——与条件边（确定性规则、属图拓扑、不占执行步）分开。本执行体只做
 * 一次无工具的 LLM 判断：读取既有消息链（缺省 = 可选系统提示 + 回合输入），
 * 追加一段结构化路由任务说明（候选清单 + “只输出一个候选 key”），模型产出
 * 的目标 key 写入状态通道 `_route_to`；图上以 `route:<key>` 条件边族把走向
 * 分发给各目标分支（注册面见 register.ts）。
 *
 * 诚实失败语义（不猜测）：无候选清单 / 未注入模型（seams.llm null）→ 空走向
 * （不写 _route_to）；模型输出未命中任何候选 → 显式写空串清陈旧决议（旧走向
 * 不残留误路由），均不臆造走向。单次调用不注入 tools（路由判断无工具语义）。
 * 决策文本不进消息链（router 是结构走向节点，不产生对话正文）。
 *
 * system 消息与 llm_decider 同 seam 约定：boot 基线（seams.boot_system_prompt）
 * 与自定义 system_prompt（config）经 compose_llm_system 合成一条（boot 恒前）；
 * boot 未注入（''）= 原自定义直取行为不变。
 */

import { NodeContract } from '../../model/contracts/contracts.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../model/schema/schemaValidator.js';
import { Message, system, user } from '../../model/llm/messages.js';
import type { AsyncLLM } from '../../model/llm/_guard_types.js';
import type { NodeFactory } from '../registry/registry_types.js';
import { STATE_MESSAGES, STATE_ROUTE_TO } from './constants.js';
import { type EngineNodeSeams, type _EngineNodeSeamsBox } from './seams.js';
import { compose_llm_system } from './llm_system.js';
import { build_read_projection, config_read_fields } from './field_io.js';

/** 归一后的路由候选条目（config.routes 条目形态收敛）。 */
interface _RouteCandidate {
  key: string;
  label: string;
  description: string;
}

/** 节点运行时上下文的消费面（执行器注入的结构超集；声明自己消费的最小面）。 */
interface _RouterCtx {
  state: Record<string, unknown>;
  thread_id?: string;
  /** 子作用域模型覆盖（agent 展开注入；null/缺省 = 回落 seams 默认 llm）。 */
  scope_llm?: AsyncLLM | null;
  account_usage?(usage: Record<string, unknown> | null): void;
}

/** config.routes 解析：对象条目 {key,label?,description?} 或纯字符串 key。
 *  非法/空 key 条目跳过（防御性，不击穿回合）；重复 key 保留首个。 */
function _parse_routes(raw: unknown): _RouteCandidate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: _RouteCandidate[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const key = item.trim();
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label: key, description: '' });
      continue;
    }
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const key = typeof record['key'] === 'string' ? (record['key'] as string).trim() : '';
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      const label =
        typeof record['label'] === 'string' && (record['label'] as string).trim() !== ''
          ? (record['label'] as string)
          : key;
      const description = typeof record['description'] === 'string' ? (record['description'] as string) : '';
      out.push({ key, label, description });
    }
  }
  return out;
}

/** 结构化路由任务说明（候选清单 + “只输出一个候选 key”）；随判断指引拼入。 */
function _route_instruction(routes: readonly _RouteCandidate[], prompt: string): string {
  const lines: string[] = [];
  lines.push('路由判断任务：根据会话内容从下列候选中选择唯一一个去向。');
  lines.push('只输出一个候选 key——原样输出候选 key，不要输出其它任何文字、解释、引号或编号：');
  lines.push('候选清单：');
  for (const route of routes) {
    const label = route.label === route.key ? '' : `（label: ${route.label}）`;
    const description = route.description !== '' ? ` ${route.description}` : '';
    lines.push(`- key=${route.key}${label}${description}`);
  }
  if (prompt !== '') lines.push(`判断指引：${prompt}`);
  return lines.join('\n');
}

/** 从模型输出中解析目标 key（严格匹配候选，不做模糊猜测）。 */
function _match_key(raw: string, keys: ReadonlySet<string>): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let candidate = trimmed;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (keys.has(candidate)) return candidate;
    const fence = candidate.match(/^```[^\n]*\n?([\s\S]*?)\n?```$/);
    if (fence !== null) {
      candidate = fence[1]!.trim();
      continue;
    }
    if (candidate.startsWith('`') && candidate.endsWith('`') && candidate.length >= 2) {
      candidate = candidate.slice(1, -1).trim();
      continue;
    }
    const quote = candidate[0];
    if (
      (quote === '"' || quote === "'") &&
      candidate.length >= 2 &&
      candidate[candidate.length - 1] === quote
    ) {
      candidate = candidate.slice(1, -1).trim();
      continue;
    }
    break;
  }
  if (keys.has(candidate)) return candidate;
  // 逐行精确匹配兜底（模型偶发换行/前缀噪声时仍不猜测）
  for (const line of candidate.split(/\r?\n/)) {
    const piece = line.trim();
    if (piece !== '' && keys.has(piece)) return piece;
  }
  return null;
}

/** 消息 JSON → Message（持久化形态回读；非法跳过防击穿）。 */
function _messageFrom(record: unknown): Message | null {
  try {
    return Message.from_dict(record as never);
  } catch {
    return null;
  }
}

/** 恢复既有消息链；无链时以（可选系统提示 + 回合输入）开局。read_fields
 *  只读投影（若有）插在路由任务说明之前；路由任务说明恒在末尾贴近判断点。
 *  决策不入链（不写回 state）。 */
function _prompt_messages(
  state: Record<string, unknown>,
  input: string,
  routes: readonly _RouteCandidate[],
  prompt: string,
  system_prompt: string,
  projection: string | null,
): Message[] {
  const stored = Array.isArray(state[STATE_MESSAGES])
    ? (state[STATE_MESSAGES] as unknown[])
        .map(_messageFrom)
        .filter((message): message is Message => message !== null)
    : [];
  const messages: Message[] = [...stored];
  if (messages.length === 0) {
    if (system_prompt !== '') messages.push(system(system_prompt));
    if (input !== '') messages.push(user(input));
  }
  if (projection !== null) messages.push(user(projection));
  messages.push(user(_route_instruction(routes, prompt)));
  return messages;
}

/** 单次模型判断流式调用：只累积正文 token（判断 key），不发射正文/思考事件。 */
async function _stream_judgment(
  llm: AsyncLLM,
  ctx: _RouterCtx,
  messages: readonly Message[],
): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of llm.astream(messages, { tools: null, params: null })) {
    if (chunk.usage !== null && chunk.usage !== undefined && typeof ctx.account_usage === 'function') {
      ctx.account_usage(chunk.usage);
    }
    if (chunk.token !== null && chunk.token !== undefined) parts.push(chunk.token);
  }
  return parts.join('');
}

/** router_judge 契约：读消息链/回合输入，产出走向决议（安全档 0）。
 *  输出字段 `_route_to` 为内部通道（声明式契约描述走向通道；空走向 = 不产出）。 */
export function router_judge_contract(): NodeContract {
  return new NodeContract({
    input_schema: null,
    output_schema: new SchemaSpec({
      name: 'router_judge.output',
      fields: [new SchemaField({ name: STATE_ROUTE_TO, required: false, kind: FIELD_STRING })],
    }),
    safety_tier: 0,
    version: 1,
  });
}

/** router_judge 工厂：seams 盒 → 节点工厂（配置 → 节点执行函数）。
 *  与 llm_decider 共用 config 化字段读约定：`read_fields`（只读投影进提示，
 *  见 field_io.ts）——router 回复落点为 `_route_to` 内部走向通道，不提供
 *  output_field 分化。 */
export function make_router_judge_factory(box: _EngineNodeSeamsBox): NodeFactory {
  return (config: Record<string, unknown>) => {
    const routes = _parse_routes(config['routes']);
    const prompt = String(config['prompt'] ?? '');
    const system_prompt = String(config['system_prompt'] ?? '');
    const read_fields = config_read_fields(config);
    const keys = new Set(routes.map((route) => route.key));

    return async (raw: unknown): Promise<Record<string, unknown> | null> => {
      const seams: EngineNodeSeams = box.current;
      const ctx = raw as _RouterCtx;
      if (routes.length === 0) return {};
      const scope_llm = ctx.scope_llm ?? null;
      const llm = scope_llm ?? seams.llm;
      if (llm === null) return {};
      const input = String(ctx.state['input'] ?? '');
      const messages = _prompt_messages(
        ctx.state,
        input,
        routes,
        prompt,
        compose_llm_system(seams.boot_system_prompt, system_prompt),
        build_read_projection(ctx.state, read_fields),
      );
      const output = await _stream_judgment(llm, ctx, messages);
      const key = _match_key(output, keys);
      if (key !== null) {
        ctx.state[STATE_ROUTE_TO] = key;
        return { [STATE_ROUTE_TO]: key };
      }
      // 显式空走向（写空清陈旧决议；`route:<key>` 条件边对空串全不命中）
      ctx.state[STATE_ROUTE_TO] = '';
      return { [STATE_ROUTE_TO]: '' };
    };
  };
}
