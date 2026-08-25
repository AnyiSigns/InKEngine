/**
 * chart 消息条目（会话流内嵌渲染）：chart spec → 自绘 SVG。
 *
 * 渲染器消费 ChartSpec（与生成端同源同规格）：折线/柱状/饼图/散点
 * 均以内联 SVG 绘制（不进附件流）。缺数据/非法 spec 降级为占位卡片
 * 不抛错。导出：SVG 字符串经回调或数据 URL 下载（可入会话附件）。
 */

import { Download } from 'lucide-react';

import type { InkChartMessage } from '@/shared/session/types';
import { isRenderableSpec, type ChartSpec } from '@/shared/charts/chart_spec';
import { chartSpecToSvgString } from '@/shared/charts/chart_export';
import { EntryFrame } from './entry_frame';

interface ChartEntryProps {
  message: InkChartMessage;
  /** 导出回调（测试注入；宿主接线则走锚点下载） */
  onExport?: (svg: string, spec: ChartSpec) => void;
}

export function ChartEntry({ message, onExport }: ChartEntryProps) {
  const spec = message.spec;

  if (!isRenderableSpec(spec)) {
    return (
      <EntryFrame
        id={message.id}
        visual="card"
        header={<div className="text-[10px] ink-text-faint">图表（数据不可用，已降级渲染）</div>}
      />
    );
  }

  const svg = chartSpecToSvgString(spec);

  const handleExport = (): void => {
    if (onExport) {
      onExport(svg, spec);
      return;
    }
    const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${spec.title ?? 'chart'}.svg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  return (
    <EntryFrame
      id={message.id}
      visual="card"
      header={
        <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
          <span className="ink-chip font-mono text-[9px]">{spec.type}</span>
          <span className="truncate">{spec.title ?? '图表'}</span>
          <button
            type="button"
            data-ui="chart_export"
            title="导出 SVG"
            onClick={handleExport}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-px ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent border-none"
          >
            <Download size={10} strokeWidth={1.6} aria-hidden />
            导出
          </button>
        </div>
      }
      body={<div className="ink-chart-host" data-chart-type={spec.type} dangerouslySetInnerHTML={{ __html: svg }} />}
    />
  );
}
