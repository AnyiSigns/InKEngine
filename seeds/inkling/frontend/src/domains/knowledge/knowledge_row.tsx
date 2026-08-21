/**
 * knowledge_row 领域组件（知识/研究孵化领域包）：检索命中/孵化信号内联微卡。
 *
 * 数据源：events.memory_recall 通道（消息流内联微卡，不占独立行）。
 * 领域组件经 domains 清单加载注册（manifest contracts 渲染组件白名单），
 * 渲染器白名单解析与机制组件一致——未登记领域组件同样拒绝渲染。
 */

import { Beaker } from 'lucide-react';

import type { HubEvent } from '@/shared/session/channelHub';

interface KnowledgeRowProps {
  bindValue?: unknown;
}

export function KnowledgeRow({ bindValue }: KnowledgeRowProps) {
  const event = bindValue as HubEvent | undefined;
  const hits = event?.payload?.hits as Array<{ id: string; title: string; snippet: string }> | undefined;

  if (!hits || hits.length === 0) return null;

  return (
    <div className="mx-3 mt-1 shrink-0 ink-panel rounded-md px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
        <Beaker size={10} strokeWidth={1.6} aria-hidden />
        检索命中 / 孵化信号
      </div>
      <div className="mt-0.5 flex flex-wrap gap-1.5">
        {hits.map((hit) => (
          <span
            key={hit.id}
            title={hit.snippet}
            className="max-w-56 truncate rounded-full border px-1.5 py-px text-[9px] ink-border ink-text-muted"
          >
            {hit.title}
          </span>
        ))}
      </div>
    </div>
  );
}
