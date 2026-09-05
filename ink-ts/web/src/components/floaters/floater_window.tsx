/**
 * 悬浮窗（复杂多步交互容器）：可拖拽 / 可缩放 / 可关闭。
 *
 * 定位（交互分层规约）：单步轻交互（发送/开关/分段选择）内联；
 * 多步/复杂交互（审批、编辑、向导）承载于悬浮窗，与主窗数据即时
 * 同步（数据层共用会话中枢/可注入存储，悬浮窗只是展示面）。
 *
 * 几何（壳层重设计）：fixed 相对视口定位，不再受宿主面板的定位上下文
 * 影响（此前 absolute 会相对无定位的面板落在视口左上角）；未传 initialRect
 * 时默认视口居中（x/y = (视口 - 尺寸)/2），可拖拽/缩放记忆位置。
 * 拖拽 = 头部手柄（pointer 与 mouse 兼容监听：浏览器走 pointer，
 * jsdom/降级环境走 mouse）；缩放 = 右下角手柄（同机制）——拖动逻辑
 * 以坐标差驱动，事件面只取 clientX/clientY。层级经 .ink-z-floater
 * （设计 token，禁直写数值）。关闭回调注入。
 */

import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import { X } from 'lucide-react';

import { RADIUS_VARIANTS, Z_VARIANTS } from '@/renderer/designTokens';

export interface FloaterRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FLOATER_MIN_WIDTH = 280;
export const FLOATER_MIN_HEIGHT = 160;

interface FloaterWindowProps {
  title: string;
  /** 悬浮窗键（尺寸/位置记忆的存储键） */
  floaterKey?: string;
  icon?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  initialRect?: Partial<FloaterRect>;
  className?: string;
  dataUi?: string;
}

const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 320;

/** 视口居中起点（未传 initialRect.x/y 时生效）。 */
function centeredOrigin(width: number, height: number): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: 96, y: 88 };
  return {
    x: Math.max(8, Math.round((window.innerWidth - width) / 2)),
    y: Math.max(8, Math.round((window.innerHeight - height) / 2)),
  };
}

type DragEvent = Pick<ReactPointerEvent<HTMLElement>, 'clientX' | 'clientY'> | Pick<ReactMouseEvent<HTMLElement>, 'clientX' | 'clientY'>;

export function FloaterWindow({
  title,
  floaterKey,
  icon,
  onClose,
  children,
  initialRect = {},
  className = '',
  dataUi,
}: FloaterWindowProps) {
  const width = initialRect.width ?? DEFAULT_WIDTH;
  const height = initialRect.height ?? DEFAULT_HEIGHT;
  const origin = centeredOrigin(width, height);
  const [rect, setRect] = useState<FloaterRect>({
    x: initialRect.x ?? origin.x,
    y: initialRect.y ?? origin.y,
    width,
    height,
  });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; originW: number; originH: number } | null>(null);

  const onDragStart = (event: DragEvent): void => {
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: rect.x, originY: rect.y };
  };

  const onDragMove = (event: DragEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    setRect((r) => ({
      ...r,
      x: Math.max(0, drag.originX + event.clientX - drag.startX),
      y: Math.max(0, drag.originY + event.clientY - drag.startY),
    }));
  };

  const onDragEnd = (): void => {
    dragRef.current = null;
  };

  const onResizeStart = (event: DragEvent): void => {
    resizeRef.current = { startX: event.clientX, startY: event.clientY, originW: rect.width, originH: rect.height };
  };

  const onResizeMove = (event: DragEvent): void => {
    const resize = resizeRef.current;
    if (!resize) return;
    setRect((r) => ({
      ...r,
      width: Math.max(FLOATER_MIN_WIDTH, resize.originW + event.clientX - resize.startX),
      height: Math.max(FLOATER_MIN_HEIGHT, resize.originH + event.clientY - resize.startY),
    }));
  };

  const onResizeEnd = (): void => {
    resizeRef.current = null;
  };

  return (
    <section
      role="dialog"
      aria-label={title}
      data-ui={dataUi ?? 'floater'}
      data-floater-key={floaterKey}
      className={`ink-pop-in fixed flex flex-col ${Z_VARIANTS.floater} ${RADIUS_VARIANTS[12]} border border-[var(--ink-border-strong)] bg-[var(--ink-bg-surface)] ${className}`}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        boxShadow: 'var(--ink-shadow-pop)',
      }}
    >
      <header
        data-ui="floater_header"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onMouseDown={onDragStart}
        onMouseMove={onDragMove}
        onMouseUp={onDragEnd}
        onMouseLeave={onDragEnd}
        className="flex h-9 shrink-0 cursor-move items-center gap-2 border-b border-[var(--ink-border)] px-3"
        style={{ touchAction: 'none' }}
      >
        {icon && <span className="ink-text-faint">{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-[var(--ink-font-xs)] font-medium">{title}</span>
        <button
          type="button"
          data-ui="floater_close"
          title="关闭"
          onClick={() => onClose?.()}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-transparent border-none cursor-pointer ink-text-faint hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
        >
          <X size={12} strokeWidth={1.6} aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      <button
        type="button"
        data-ui="floater_resize_handle"
        title="拖拽改变大小"
        aria-label="拖拽改变大小"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onMouseDown={onResizeStart}
        onMouseMove={onResizeMove}
        onMouseUp={onResizeEnd}
        className="absolute right-1 bottom-1 h-4 w-4 cursor-nwse-resize bg-transparent border-none"
        style={{ touchAction: 'none' }}
      />
    </section>
  );
}
