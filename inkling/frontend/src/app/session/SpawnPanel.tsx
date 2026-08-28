/**
 * 子代理会话面板（右侧滑入浮窗）：实例清单 + 选中实例独立会话流 + 补充指令。
 */

import { useState } from 'react';
import { ChevronLeft, Send, Loader2 } from 'lucide-react';

export interface SpawnInstance {
  index: number;
  label: string;
  status: 'running' | 'completed' | 'failed';
  duration?: number;
  chainTail?: string;
}

export interface SpawnPanelProps {
  open: boolean;
  onClose: () => void;
  instances: SpawnInstance[];
  selectedIndex: number | null;
  onSelectIndex: (index: number) => void;
  onSendInstruction: (text: string) => void;
  streaming: boolean;
}

export function SpawnPanel({ open, onClose, instances, selectedIndex, onSelectIndex, onSendInstruction, streaming }: SpawnPanelProps) {
  const [instruction, setInstruction] = useState('');
  const selected = instances.find((i) => i.index === selectedIndex) ?? instances[0] ?? null;

  if (!open) return null;

  const submit = () => {
    if (!instruction.trim() || streaming) return;
    onSendInstruction(instruction.trim());
    setInstruction('');
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-2xl border-l ink-border bg-[var(--ink-bg-base)] shadow-xl">
        <div className="flex w-48 flex-col border-r ink-border">
          <div className="border-b ink-border px-3 py-2 text-xs font-medium">子代理实例</div>
          <div className="flex-1 overflow-y-auto p-2">
            {instances.map((inst) => (
              <button
                key={inst.index}
                type="button"
                onClick={() => onSelectIndex(inst.index)}
                className={`mb-1 w-full rounded-lg border px-2 py-2 text-left text-xs ${
                  inst.index === selectedIndex ? 'ink-border-strong bg-[var(--ink-bg-elevated)]' : 'ink-border hover:bg-[var(--ink-bg-elevated)]'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${inst.status === 'running' ? 'bg-[var(--ink-status-running)] animate-pulse' : inst.status === 'completed' ? 'bg-[var(--ink-status-ok)]' : 'bg-[var(--ink-status-warn)]'}`} />
                  <span className="flex-1 truncate">{inst.label}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 ink-text-faint">
                  <span>{inst.status === 'running' ? '执行中' : inst.status === 'completed' ? '已完成' : '已剔除'}</span>
                  {inst.duration != null && <span>· {(inst.duration / 1000).toFixed(1)}s</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-1 flex-col">
          <div className="flex items-center gap-2 border-b ink-border px-4 py-2">
            <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--ink-bg-elevated)]">
              <ChevronLeft size={14} strokeWidth={1.5} />
            </button>
            <span className="text-sm font-medium">{selected?.label ?? '子代理'}</span>
            <span className="ink-text-faint text-xs">:spawn:{selected?.index ?? 0}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {selected ? (
              <div className="space-y-3">
                <div className="ink-status-card rounded-xl p-3">
                  <div className="text-xs font-medium">实例详情</div>
                  <div className="mt-2 text-xs ink-text-muted">
                    <p>状态：{selected.status === 'running' ? '执行中' : selected.status === 'completed' ? '已完成' : '已剔除'}</p>
                    {selected.chainTail && <p>链尾：{selected.chainTail}</p>}
                  </div>
                </div>
                <div className="ink-status-card rounded-xl p-3">
                  <div className="text-xs font-medium">会话流</div>
                  <div className="mt-2 text-xs ink-text-faint">暂无事件</div>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-xs ink-text-faint">选择实例查看详情</div>
            )}
          </div>
          <div className="border-t ink-border p-3">
            <div className="flex items-end gap-2">
              <textarea
                className="ink-input-shell flex-1 rounded-xl border px-3 py-2 text-xs"
                rows={1}
                placeholder="补充指令：让这个子代理…"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                disabled={streaming}
              />
              {streaming ? (
                <button type="button" disabled className="flex h-8 w-8 items-center justify-center rounded-lg ink-text-muted">
                  <Loader2 size={16} strokeWidth={1.5} className="animate-spin" />
                </button>
              ) : (
                <button type="button" onClick={submit} disabled={!instruction.trim()} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ink-text-base)] text-[var(--ink-bg-base)] disabled:opacity-40">
                  <Send size={16} strokeWidth={1.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
