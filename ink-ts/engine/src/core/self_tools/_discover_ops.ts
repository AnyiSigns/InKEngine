/**
 * 自指元工具发现操作面（core/self_tools.py _search_tools/_request_tool
 * 移植）。
 *
 * search_tools：自然语言查询 → 工具索引匹配（≤8 条），索引缺失/为空 =
 * 显式降级返回（检索到 ≠ 可用，绑定才注入会话窗口）；request_tool：
 * 注册表校验 → 打 thread 标签注入完整 schema（绑定 = 会话级、thread
 * 隔离、同会话重复幂等），响应携带端点状态（绑定 ≠ 端点可用）。
 */

import { isAwaitable } from '../tool_pipeline/_types.js';
import { TAG_THREAD_PREFIX } from './_constants.js';
import { _json } from './_json.js';
import type { SelfToolContext, SelfToolNodeContext } from './_types.js';

/** 工具检索：自然语言查询 → 匹配工具列表（≤8 条）。 */
export async function _search_tools(
  _ctx: SelfToolNodeContext,
  context: SelfToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = args['query'];
  if (typeof query !== 'string' || !query.trim()) {
    return _json({ ok: false, violations: ['query 须为非空字符串'] });
  }
  const index = context.tool_index;
  if (index === null || index.size() === 0) {
    return _json({
      ok: true,
      results: [],
      degraded: true,
      degraded_reason: '工具索引未装配',
    });
  }
  const results = index.search(query.trim(), 8);
  const probe = context.endpoint_probe;
  const resultRows: Record<string, unknown>[] = [];
  for (const result of results) {
    const row: Record<string, unknown> = {
      name: result.name,
      description: result.description,
      parameters_summary: result.parameters_summary,
      tier: result.tier,
      endpoint: result.endpoint,
    };
    if (probe !== null) {
      try {
        row['endpoint_status'] = probe(result.name);
      } catch {
        row['endpoint_status'] = null;
      }
    }
    resultRows.push(row);
  }
  return _json({
    ok: true,
    results: resultRows,
    degraded: !index.uses_vectors(),
    degraded_reason: index.uses_vectors()
      ? null
      : '向量嵌入不可用，已降级为关键词基线匹配——结果可能不含语义相近工具',
  });
}

/** 工具绑定：注册表校验 → 完整 schema 注入下一轮 tools。 */
export async function _request_tool(
  ctx: SelfToolNodeContext,
  context: SelfToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const rawName = args['name'];
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return _json({ ok: false, violations: ['name 须为非空字符串'] });
  }
  const name = rawName.trim();
  const index = context.tool_index;
  if (index === null || !index.has(name)) {
    // 错误提示避免死循环：search_tools 依赖同一索引，索引缺失时
    // 「检索后绑定」同样找不到——明确区分未注册与索引未含两种形态
    let registered = false;
    const registry = context.harness_registry;
    if (registry !== null) {
      registered = name in registry.declarative.definitions;
    }
    if (registered) {
      return _json({
        ok: false,
        error: `工具 ${name} 已注册但索引尚未刷新，当前回合无法绑定；`
          + '请在新回合（或索引重建后）重试',
      });
    }
    return _json({
      ok: false,
      error: `未注册工具名 ${name}（可用 propose_patch/apply_patch 自写工具，`
        + '或 search_tools 检索已注册工具）',
    });
  }
  const spec = index.spec(name);
  if (spec === null) {
    return _json({
      ok: false,
      error: `未注册工具名 ${name}（工具描述缺失）`,
    });
  }
  // 单源 + 标签：绑定 = 给当前会话 thread 打标签（会话窗口恒注入）。
  // 同 thread 重复绑定幂等（标签集合语义）；不同 thread 各自打标互不
  // 影响（thread 隔离）；ctx.thread_id 缺省（离线/单测）退化为纯校验。
  // tagger 可为同步打标（调用方负责持久化）或 async 持久化闭包
  const threadId = ctx.thread_id;
  const tagger = context.tool_tagger;
  if (tagger !== null && threadId) {
    try {
      const result = tagger(name, `${TAG_THREAD_PREFIX}${threadId}`);
      if (isAwaitable(result)) await result;
    } catch {
      return _json({
        ok: false,
        error: '工具绑定失败（会话标签写入异常），请稍后重试',
      });
    }
  }
  // 端点探活：绑定 ≠ 端点可用——MCP/远程端点未连接时如实标注，
  // 不让「已绑定」误导调用方（绑定只是注册表校验 + schema 注入）
  let endpointStatus: Record<string, unknown> | null = null;
  const probe = context.endpoint_probe;
  if (probe !== null) {
    try {
      endpointStatus = probe(name);
    } catch {
      endpointStatus = { endpoint: 'unknown', connected: false, reason: '端点探活失败' };
    }
  }
  const response: Record<string, unknown> = {
    ok: true,
    message:
      `已绑定 ${name}，当前会话窗口（thread 内）可调用；其它会话/后续新会话需重新绑定`,
    spec: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      permissions: [...spec.permissions],
    },
  };
  if (endpointStatus !== null) {
    response['endpoint_status'] = endpointStatus;
    if (endpointStatus['connected'] !== true) {
      response['message'] = `${response['message']}（注意：端点未连接 connected=false，调用前须先恢复端点）`;
    }
  }
  return _json(response);
}
