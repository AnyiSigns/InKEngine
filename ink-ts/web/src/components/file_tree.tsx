/**
 * 文件树（左侧工作区侧栏，可收缩）：工作区文件树 + 底部设置入口。
 *
 * 三栏布局左栏（DeepSeek harness 参照，Linear 风格侧栏）：文件树展示
 * 领域工作区结构（知识集/领域包/规则/补丁链），目录可展开、文件可选
 * （active 态 = 抬升面 + 左侧墨条）。底部固定设置入口（其它视图入口
 * 统一收进设置页）+ 工作区状态行。轨道经 ink-rail 光泽 + hairline 分隔。
 *
 * 纯展示组件：树数据 props 注入（夹具/集成期由宿主数据源提供），
 * 导航经 onNavigate 注入（渲染器 chromeProps）。收起/展开为本地 UI 状态。
 */

import { useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, FileText, Folder, FolderOpen, Settings } from 'lucide-react';

import type { ViewId } from '@/renderer/uiSpecTypes';
import { cn } from '@/shared/cn';

export interface FileNode {
  name: string;
  kind: 'dir' | 'file';
  children?: FileNode[];
}

interface FileTreeProps {
  collapsible?: boolean;
  files?: FileNode[];
  activeFile?: string;
  onNavigate?: (view: ViewId) => void;
  /** 文件行点击回调（宿主接线：打开展示/路由）；未注入时仍本地置 active。 */
  onOpenFile?: (name: string) => void;
}

export function FileTree({ collapsible = false, files = [], activeFile = '', onNavigate, onOpenFile }: FileTreeProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState(activeFile);

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-r py-2 ink-border">
        <button
          data-ui="btn_tree_expand"
          title="展开文件树"
          onClick={() => setCollapsed(false)}
          className="flex h-7 w-7 items-center justify-center rounded-lg ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
        >
          <ChevronRight size={13} strokeWidth={1.6} />
        </button>
        <button
          data-ui="btn_settings_rail"
          title="设置"
          onClick={() => onNavigate?.('settings')}
          className="flex h-7 w-7 items-center justify-center rounded-lg ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
        >
          <Settings size={13} strokeWidth={1.6} />
        </button>
      </div>
    );
  }

  return (
    <div className="ink-rail flex w-60 shrink-0 flex-col border-r ink-border">
      <div className="flex h-11 items-center gap-1.5 px-3">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-tight">工作区</span>
        <span className="shrink-0 font-mono text-[9px] ink-text-faint">~/inkling</span>
        {collapsible && (
          <button
            data-ui="btn_tree_collapse"
            title="收起文件树"
            onClick={() => setCollapsed(true)}
            className="flex h-7 w-6 shrink-0 items-center justify-center rounded-lg ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
          >
            <ChevronLeft size={13} strokeWidth={1.6} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
        {files.map((node) => (
          <FileRow
            key={node.name}
            node={node}
            depth={0}
            activeFile={activeFile || selected}
            onOpenFile={(name) => {
              setSelected(name);
              onOpenFile?.(name);
            }}
          />
        ))}
      </div>
      <div className="border-t px-2 py-1.5 ink-border">
        <button
          data-ui="btn_settings"
          onClick={() => onNavigate?.('settings')}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left cursor-pointer ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
        >
          <Settings size={11} strokeWidth={1.6} aria-hidden />
          <span className="text-[11px]">设置</span>
        </button>
      </div>
    </div>
  );
}

function FileRow({ node, depth, activeFile, onOpenFile }: { node: FileNode; depth: number; activeFile: string; onOpenFile: (name: string) => void }) {
  const [open, setOpen] = useState(depth === 0);
  const isDir = node.kind === 'dir';
  const active = !isDir && node.name === activeFile;

  if (isDir) {
    return (
      <div>
        <button
          data-ui={`tree_dir_${node.name}`}
          onClick={() => setOpen((v) => !v)}
          style={{ paddingLeft: depth * 12 + 6 }}
          className="flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left cursor-pointer hover:bg-[var(--ink-bg-elevated)]"
        >
          {open ? (
            <ChevronDown size={10} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
          ) : (
            <ChevronRight size={10} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
          )}
          {open ? (
            <FolderOpen size={11} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
          ) : (
            <Folder size={11} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
          )}
          <span className="truncate text-[11px]">{node.name}</span>
        </button>
        {open &&
          node.children?.map((child) => (
            <FileRow key={child.name} node={child} depth={depth + 1} activeFile={activeFile} onOpenFile={onOpenFile} />
          ))}
      </div>
    );
  }

  return (
    <button
      data-ui={`tree_file_${node.name}`}
      title={node.name}
      onClick={() => onOpenFile(node.name)}
      style={{ paddingLeft: depth * 12 + 6 }}
      className={cn(
        'relative flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left cursor-pointer',
        active
          ? 'bg-[var(--ink-bg-elevated)]'
          : 'hover:bg-[var(--ink-bg-elevated)]',
      )}
    >
      {active && <span className="ink-active-bar" aria-hidden />}
      <FileText size={11} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate text-[11px]', active ? 'font-medium' : 'ink-text-muted')}>
        {node.name}
      </span>
    </button>
  );
}
