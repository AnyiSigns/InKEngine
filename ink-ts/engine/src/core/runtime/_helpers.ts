/**
 * 运行时装配辅助（runtime.py 模块级函数移植）：工具 spec 确定性身份。
 *
 * 供引擎重建缓存键使用：取 spec 的确定性 JSON 序列化（排序键），同名但
 * 被补丁改写的工具（端点/参数/协议等）产生不同身份，从而触发引擎重建
 * （节点类型只注册一次，旧缓存命中会让差异化重写无效）。
 */

import { isRecord } from '../json.js';
import type { ToolSpec } from '../llm/tools.js';

/** 深度排序键递归（镜像 Python json.dumps(sort_keys=True) 的键序）。 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/**
 * 工具 spec 的确定性结构身份。
 *
 * 序列化来源：``to_dict()``（ToolSpec 的数据形态）→ 字段透传 → repr。
 * 任何一步失败都回落，不得让缓存键计算抛错击穿引擎重建。
 */
export function _spec_identity(spec: ToolSpec): string {
  let body: unknown = null;
  const toDict = (spec as { to_dict?: unknown }).to_dict;
  if (typeof toDict === 'function') {
    try {
      body = (toDict as () => unknown)();
    } catch {
      body = null;
    }
  }
  if (body === null) {
    const record: Record<string, unknown> = {};
    const self = spec as unknown as Record<string, unknown>;
    for (const key of ['name', 'description', 'parameters', 'permissions']) {
      record[key] = self[key];
    }
    body = record;
  }
  try {
    return JSON.stringify(sortKeys(body));
  } catch {
    try {
      return String(body);
    } catch {
      return String(spec);
    }
  }
}
