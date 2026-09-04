/**
 * harness 构造辅助（harness.py 移植：领域生成器起点形态 + 默认匹配器）。
 *
 * build_minimal_harness = 领域生成器产出的起点形态：name/description/
 * keywords 为能力标识（路由匹配依据），tools/graph 可选——最小领域可只含
 * 标识而无图无工具（纯能力标记，route 仍可命中），后续经 harness 补丁
 * 叠加工具与图。返回对象交 HarnessRegistry.register 即走注册期校验。
 *
 * _keyword_match = 默认能力匹配器：关键词命中率（确定性、零 LLM 调用）；
 * 宿主可注入语义检索等更精细的匹配器——换匹配器不改装配。
 */
import { GraphDefinitionError } from '../errors.js';
import { deepCopy, isRecord, type Json } from '../json.js';
import {
  type CapabilityMatcher,
  HarnessDefinition,
} from './definition.js';

export type { CapabilityMatcher };

/** build_minimal_harness 的可选携带项（对应 Python kw-only 参数）。 */
export interface BuildMinimalHarnessOptions {
  tools?: readonly Record<string, unknown>[];
  graph?: Record<string, unknown> | null;
  default_plan?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
}

/**
 * 构造最小可用 harness 定义（领域生成器的起点形态）。
 *
 * 生成器产出即校验：空名/非字符串描述/空关键词/工具非 dict/图与 meta
 * 非 dict 在此暴露（GraphDefinitionError），语义非法不在下游注册期才暴露。
 *
 * @throws GraphDefinitionError 输入形态非法（与 Python 文案同源）。
 */
export function build_minimal_harness(
  name: string,
  description: string,
  keywords: readonly string[],
  options: BuildMinimalHarnessOptions = {},
): HarnessDefinition {
  if (typeof name !== 'string' || !name.trim()) {
    throw new GraphDefinitionError('harness 名须为非空字符串');
  }
  if (typeof description !== 'string') {
    throw new GraphDefinitionError('harness 描述须为字符串');
  }
  if (
    !Array.isArray(keywords) ||
    keywords.length === 0 ||
    !keywords.every((item) => typeof item === 'string' && Boolean(item.trim()))
  ) {
    throw new GraphDefinitionError('harness 关键词须为非空字符串清单');
  }
  const { tools = [], graph = null, default_plan = null, meta = null } = options;
  if (
    !Array.isArray(tools) ||
    !tools.every((item) => isRecord(item))
  ) {
    throw new GraphDefinitionError('harness 工具须为声明式工具定义 dict 清单');
  }
  const optionalPairs: Array<[string, unknown, string]> = [
    ['graph', graph, 'dict'],
    ['default_plan', default_plan, 'dict'],
    ['meta', meta, 'dict'],
  ];
  for (const [optionalName, optionalValue, kind] of optionalPairs) {
    if (optionalValue !== null && optionalValue !== undefined && !isRecord(optionalValue)) {
      throw new GraphDefinitionError(`harness ${optionalName} 须为 ${kind}`);
    }
  }
  return new HarnessDefinition({
    name,
    description,
    keywords: [...keywords],
    tools: [...tools],
    graph:
      graph !== null && graph !== undefined
        ? (deepCopy(graph as unknown as Json) as unknown as Record<string, unknown>)
        : null,
    default_plan:
      default_plan !== null && default_plan !== undefined
        ? (deepCopy(default_plan as unknown as Json) as unknown as Record<string, unknown>)
        : null,
    meta:
      meta !== null && meta !== undefined && Object.keys(meta).length > 0
        ? (deepCopy(meta as unknown as Json) as unknown as Record<string, unknown>)
        : {},
  });
}

/**
 * 默认能力匹配器：关键词命中率（确定性，零 LLM 调用）。
 *
 * 相关度 = 命中关键词数 / 关键词总数（无关键词 = 0 相关）；子串命中
 * 计入（任务描述含关键词即视为相关信号）。数值可解释、可断言。
 */
export function _keyword_match(task: string, definition: HarnessDefinition): number {
  if (definition.keywords.length === 0) return 0.0;
  let hits = 0;
  for (const keyword of definition.keywords) {
    if (task.includes(keyword)) hits += 1;
  }
  return hits / definition.keywords.length;
}
