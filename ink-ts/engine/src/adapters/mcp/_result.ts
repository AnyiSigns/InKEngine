/**
 * MCP 调用结果文本收敛（镜像 Python mcp_client.py 的 _result_is_error /
 * _extract_text；截断上限与引擎 tool_pipeline.DEFAULT_MAX_RESULT_CHARS
 * 共享常量，ENG6-6 单点维护防漂移）。
 *
 * 结果体 ``content`` 为内容项列表；内容项兼容 dict 与对象两形态（dict
 * 形态常见于经 JSON 往返的代理/测试桩/自写传输）；文本项按 text 拼接并
 * 统一强转字符串，非文本项标注类型（``[<type>]``）后落明——不静默丢弃
 * 任何回执信息，也不把二进制/资源内容伪装成纯文本。
 */
import { DEFAULT_MAX_RESULT_CHARS } from '../../core/tool_pipeline/tool_pipeline.js';
import type { McpCallResult } from './_types.js';

/** MCP 调用结果的失败标记（dict 与对象两形态；is_error 优先，isError 为
 *  1.x 遗留数据/自定义桩的防御性回退）。 */
export function result_is_error(result: McpCallResult): boolean {
  let marker = result['is_error'];
  if (marker === null || marker === undefined) marker = result['isError'];
  return Boolean(marker);
}

/** 内容项文本读取（dict/对象两形态；无 text = null）。 */
function _item_text(item: unknown): unknown {
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    return (item as Record<string, unknown>)['text'];
  }
  return null;
}

/** 内容项类型标注（缺省 unknown）。 */
function _item_type(item: unknown): string {
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const type = (item as Record<string, unknown>)['type'];
    return typeof type === 'string' ? type : 'unknown';
  }
  return 'unknown';
}

/** 从 MCP 调用结果提取文本（dict 与对象两形态；超限截断落溢出标记）。 */
export function extract_text(result: McpCallResult): string {
  const content = result['content'];
  if (!Array.isArray(content) || content.length === 0) return '';
  const parts: string[] = [];
  for (const item of content) {
    const text = _item_text(item);
    if (text !== null && text !== undefined) {
      parts.push(String(text));
      continue;
    }
    parts.push(`[${_item_type(item)}]`);
  }
  let body = parts.join('\n');
  if (body.length > DEFAULT_MAX_RESULT_CHARS) {
    body = body.slice(0, DEFAULT_MAX_RESULT_CHARS) + '\n…（溢出截断）';
  }
  return body;
}
