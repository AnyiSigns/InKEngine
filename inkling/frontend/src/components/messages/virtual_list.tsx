/**
 * 长列表虚拟化：按可见窗口渲染（滚动条按总量估高，实测高度回填修正）。
 *
 * 定位：消息流的健壮性机制（千条级消息不卡渲染），不改动事件序与
 * 条目结构——未被窗口覆盖的条目只是不绘制，数据仍在（tail 截断在
 * 列表层之上另行处理）。
 *
 * 高度估算：未实测条目按预估高（测得均值或默认值）累加；每行 ref
 * 回调实测 height 回填（jsdom 下恒 0 → 持续走估算，不影响正确性）。
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export const DEFAULT_ESTIMATED_ITEM_HEIGHT = 76;
export const DEFAULT_VIEWPORT_HEIGHT = 600;
export const DEFAULT_OVERSCAN = 6;

interface VirtualListProps<T> {
  items: T[];
  keyOf: (item: T, index: number) => string;
  renderItem: (item: T, index: number, measure: (height: number) => void) => ReactNode;
  /** 预估行高（未实测时的估算基准） */
  estimatedHeight?: number;
  /** 视口高度（缺省实测，jsdom 无布局时回落默认） */
  viewportHeight?: number;
  /** 上下缓冲行数 */
  overscan?: number;
  className?: string;
  /** 内容长度信号：新条目追加后贴近底部时滚动跟随（上翻不打断） */
  followSignal?: number;
  /** 空列表占位 */
  emptyHint?: ReactNode;
  dataUi?: string;
}

export function VirtualList<T>({
  items,
  keyOf,
  renderItem,
  estimatedHeight = DEFAULT_ESTIMATED_ITEM_HEIGHT,
  viewportHeight,
  overscan = DEFAULT_OVERSCAN,
  className = '',
  followSignal,
  emptyHint = null,
  dataUi,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const measuredRef = useRef(new Map<number, number>());
  const pinnedRef = useRef(true);

  const measure = (index: number, height: number): void => {
    if (height <= 0) return; // 无布局（jsdom/隐藏容器）不污染估算
    if (measuredRef.current.get(index) === height) return;
    measuredRef.current.set(index, height);
    setScrollTop((top) => top); // 触发窗口重算
  };

  const heights = items.map((_, index) => measuredRef.current.get(index) ?? estimatedHeight);
  let totalHeight = 0;
  const rowOffsets: number[] = [];
  for (const h of heights) {
    rowOffsets.push(totalHeight);
    totalHeight += h;
  }

  // 视口高实测（jsdom 无布局回落默认值）
  const containerEl = containerRef.current;
  const viewport = viewportHeight ?? (containerEl && containerEl.clientHeight > 0 ? containerEl.clientHeight : DEFAULT_VIEWPORT_HEIGHT);

  // 窗口计算（含 overscan 缓冲）
  let start = 0;
  let end = items.length;
  if (items.length > 0) {
    start = Math.max(0, Math.floor(scrollTop / estimatedHeight) - overscan);
    end = Math.min(items.length, Math.ceil((scrollTop + viewport) / estimatedHeight) + overscan);
  }
  const windowTop = start < rowOffsets.length ? rowOffsets[start] : 0;
  const windowHeight = (rowOffsets[end] ?? totalHeight) - windowTop;

  const onScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };

  // 内容追加跟随：贴近底部才滚（用户上翻不打断）；初始即贴底（新消息
  // 到达时窗口起点落在最新处）。jsdom 无布局（scrollHeight 恒 0）时按
  // 估算总量换算，保证窗口从尾部渲染。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !pinnedRef.current) return;
    const layoutHeight = el.scrollHeight > 0 ? el.scrollHeight : totalHeight;
    const target = Math.max(0, layoutHeight - viewport);
    if (target > 0) {
      try {
        el.scrollTop = target;
      } catch {
        // 只读环境静默
      }
      setScrollTop(el.scrollTop);
    }
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: target });
    }
  }, [followSignal, totalHeight, viewport]);

  return (
    <div
      ref={containerRef}
      data-ui={dataUi}
      className={className}
      onScroll={onScroll}
      style={{ overflowY: 'auto', position: 'relative' }}
    >
      {items.length === 0 && emptyHint}
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: windowTop, left: 0, right: 0, height: windowHeight }}>
          {items.slice(start, end).map((item, windowIndex) => {
            const index = start + windowIndex;
            return (
              <div
                key={keyOf(item, index)}
                ref={(el) => {
                  if (el) measure(index, el.offsetHeight);
                }}
                data-virtual-index={index}
              >
                {renderItem(item, index, (h) => measure(index, h))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
