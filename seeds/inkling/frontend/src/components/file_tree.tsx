/**
 * 文件树（左侧工作区侧栏，可收缩）：工作区文件树 + 底部设置入口。
 *
 * 三栏布局左栏（DeepSeek harness 参照）：文件树展示领域工作区结构
 * （知识集/领域包/规则/补丁链），目录可展开、文件可选中（border-l 高亮）。
 * 底部固定设置入口（其它视图入口统一收进设置页）+ 工作区状态行。
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

const DEMO_FILES: FileNode[] = [
  {
    name: '~/inkling',
    kind: 'dir',
    children: [
      {
        name: 'knowledge',
        kind: 'dir',
        children: [
          { name: '引用质量校验规则.md', kind: 'file' },
          { name: '领域术语表.md', kind: 'file' },
        ],
      },
      {
        name: 'domains',
        kind: 'dir',
        children: [{ name: 'knowledge', kind: 'dir', children: [{ name: 'manifest.json', kind: 'file' }] }],
      },
      {
        name: 'rules',
        kind: 'dir',
        children: [
          { name: 'approval_L1.json', kind: 'file' },
          { name: 'sample_gate.json', kind: 'file' },
        ],
      },
      {
        name: 'patches',
        kind: 'dir',
        children: [{ name: 'p-0001 引用校验.applied', kind: 'file' }],
      },
    ],
  },
];

interface FileTreeProps {
  collapsible?: boolean;
  files?: FileNode[];
  activeFile?: string;
  onNavigate?: (view: ViewId) => void;
}

export function FileTree({ collapsible = false, files = DEMO_FILES, activeFile = '', onNavigate }: FileTreeProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center py-2">
        <button
          data-ui="btn_tree_expand"
          title="展开文件树"
          onClick={() => setCollapsed(false)}
          className="flex h-7 w-7 items-center justify-center rounded-md ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
        >
          <ChevronRight size={13} strokeWidth={1.6} />
        </button>
        <button
          data-ui="btn_settings_rail"
          title="设置"
          onClick={() => onNavigate?.('settings')}
          className="mt-auto flex h-7 w-7 items-center justify-center rounded-md ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
        >
          <Settings size={13} strokeWidth={1.6} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-60 shrink-0 flex-col bg-[var(--ink-bg-surface)]">
      <div className="flex h-10 items-center gap-1 px-3">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">工作区</span>
        <span className="shrink-0 font-mono text-[9px] ink-text-faint">~/inkling</span>
        {collapsible && (
          <button
            data-ui="btn_tree_collapse"
            title="收起文件树"
            onClick={() => setCollapsed(true)}
            className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
          >
            <ChevronLeft size={13} strokeWidth={1.6} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
        {files.map((node) => (
          <FileRow key={node.name} node={node} depth={0} activeFile={activeFile} />
        ))}
      </div>
      <div className="border-t p-1.5 ink-border">
        <button
          data-ui="btn_settings"
          onClick={() => onNavigate?.('settings')}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left cursor-pointer ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
        >
          <Settings size={11} strokeWidth={1.6} aria-hidden />
          <span className="text-[11px]">设置</span>
        </button>
      </div>
    </div>
  );
}

function FileRow({ node, depth, activeFile }: { node: FileNode; depth: number; activeFile: string }) {
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
          className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left cursor-pointer hover:bg-[var(--ink-bg-elevated)]"
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
            <FileRow key={child.name} node={child} depth={depth + 1} activeFile={activeFile} />
          ))}
      </div>
    );
  }

  return (
    <button
      data-ui={`tree_file_${node.name}`}
      style={{ paddingLeft: depth * 12 + 6 }}
      className={cn(
        'flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left cursor-pointer',
        active
          ? 'bg-[var(--ink-bg-elevated)]'
          : 'hover:bg-[var(--ink-bg-elevated)]',
      )}
    >
      <FileText size={11} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate text-[11px]', active ? 'font-medium' : 'ink-text-muted')}>
        {node.name}
      </span>
    </button>
  );
}
