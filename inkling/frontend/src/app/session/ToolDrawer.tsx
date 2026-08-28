/**
 * 工具输出抽屉（C 区侧浮）：结果类截断后「查看完整」触发。
 */

import { X } from 'lucide-react';

export interface ToolDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function ToolDrawer({ open, onClose, title, children }: ToolDrawerProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative h-full w-full max-w-lg border-l ink-border bg-[var(--ink-bg-base)] shadow-xl">
        <div className="flex items-center justify-between border-b ink-border px-4 py-3">
          <span className="text-sm font-medium">{title}</span>
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--ink-bg-elevated)]">
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="overflow-y-auto p-4 text-xs leading-relaxed">
          {children}
        </div>
      </div>
    </div>
  );
}
