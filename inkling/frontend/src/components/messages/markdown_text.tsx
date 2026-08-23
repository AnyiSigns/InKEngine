/**
 * Markdown 正文渲染（助手消息正文的唯一出口）。
 *
 * HTML 一律经 renderMarkdownSafe 消毒后注入（marked + DOMPurify）；
 * .ink-markdown 容器带 whitespace-pre-wrap 回退——纯文本换行不被
 * 段落合并吞掉。文本变化时仅重算并重渲（useMemo 记忆化）。
 */

import { useMemo } from 'react';

import { cn } from '@/shared/cn';
import { renderMarkdownSafe } from '@/shared/markdown/markdown';

export function MarkdownText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdownSafe(text), [text]);
  return <div className={cn('ink-markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
