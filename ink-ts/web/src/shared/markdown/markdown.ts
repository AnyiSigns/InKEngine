/**
 * Markdown 渲染管线（marked 解析 + DOMPurify 消毒）。
 *
 * 纪律：任何模型/引擎文本进入 DOM 前必须经消毒——marked 只负责
 * 解析为 HTML，DOMPurify 剥离 script/iframe/事件属性/危险 URL 协议
 * （javascript:/data: 等），组件以 dangerouslySetInnerHTML 消费
 * 消毒后的安全 HTML。渲染容器另有 whitespace-pre-wrap 回退：纯
 * 文本换行在无标记时也按原文展示（markdown 的段落合并不吞换行）。
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** 消毒后 HTML 输出（含 URL 协议净化；解析失败回落文本转义）。 */
export function renderMarkdownSafe(source: string): string {
  const raw = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
  });
}

/** 是否包含可被消毒的潜在危险标记（诊断用）。 */
export function containsMarkdownSyntax(source: string): boolean {
  return /[#*`>\[\]|]/.test(source);
}
