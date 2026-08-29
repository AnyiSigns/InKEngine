/**
 * 左栏：品牌行（折叠钮）+ 工作区（授权根目录）+ 底部设置入口。
 * 全高贯穿窗口左侧（顶栏不再常驻，栏体不被顶栏截断），
 * 默认 224px 展开，可折叠为 48px 图标条。
 *
 * 优化（壳层重设计）：
 * - 折叠动画：宽度 180ms + 内容淡出（opacity），合成器友好，无跳动；
 * - 工作区授权态卡：已授权 = 根目录名 + 路径 hint + 换用按钮；未授权 =
 *   虚线引导卡（说明 + 选择目录按钮），不再用两个风格不同的裸按钮；
 * - 底部设置入口与品牌行同款几何（图标 + 文字行），折叠态纯图标。
 *
 * 机制/市场导航不进左栏（统一收纳在设置页各节，全部对用户开放）；
 * 添加工作区走原生目录选择器 + workspace_authorize（由装配层回调执行）。
 */

import { CheckCircle2, FolderOpen, FolderPlus, PanelLeftClose, PanelLeftOpen, Settings2 } from 'lucide-react';

interface LeftRailProps {
  collapsed: boolean;
  onToggle: () => void;
  authorized: boolean;
  /** 已授权根目录（authorized 时展示；未授权为 null）。 */
  workspaceRoot?: string | null;
  /** 点击添加/更换工作区（装配层弹原生目录选择器并执行授权）。 */
  onAddWorkspace: () => void;
  onOpenSettings: () => void;
}

export function LeftRail({
  collapsed,
  onToggle,
  authorized,
  workspaceRoot,
  onAddWorkspace,
  onOpenSettings,
}: LeftRailProps) {
  const rootName = workspaceRoot ? workspaceRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? workspaceRoot : null;

  return (
    <aside
      className={`ink-rail flex shrink-0 flex-col border-r ink-border transition-[width] duration-[180ms] ease-out ${collapsed ? 'w-12' : 'w-56'}`}
    >
      {/* 品牌行：产品字标 + 折叠钮（参考形态：logo 左、折叠图标右，无分割线） */}
      <div className={`flex h-14 shrink-0 items-center ${collapsed ? 'justify-center px-2' : 'justify-between px-4'}`}>
        {!collapsed && (
          <span className="overflow-hidden whitespace-nowrap text-[15px] font-semibold tracking-tight">InKling</span>
        )}
        <button
          type="button"
          onClick={onToggle}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ink-text-muted transition-colors hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          data-ui="left_rail_toggle"
        >
          {collapsed ? <PanelLeftClose size={16} strokeWidth={1.6} /> : <PanelLeftOpen size={16} strokeWidth={1.6} />}
        </button>
      </div>

      {/* 工作区 */}
      <div className="ink-scroll-auto min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <div className={`transition-opacity duration-[150ms] ${collapsed ? 'pointer-events-none opacity-0' : 'opacity-100'}`}>
          {!collapsed && (
            <div className="px-1.5 pb-2 text-[11px] font-medium tracking-wide ink-text-faint">工作区</div>
          )}

          {authorized && rootName ? (
            <div
              className="flex items-start gap-2.5 rounded-xl border border-[var(--ink-border)] bg-[var(--ink-bg-surface)] p-2.5"
              data-ui="workspace_root"
              title={workspaceRoot ?? ''}
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--ink-bg-elevated)]">
                <FolderOpen size={14} strokeWidth={1.6} className="ink-text-muted" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{rootName}</span>
                  <CheckCircle2 size={12} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-label="已授权" />
                </div>
                <p className="mt-0.5 truncate text-[10px] leading-relaxed ink-text-faint">{workspaceRoot}</p>
                <button
                  type="button"
                  onClick={onAddWorkspace}
                  className="mt-1.5 text-[11px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent border-none p-0"
                >
                  更换目录
                </button>
              </div>
            </div>
          ) : (
            <div
              className="rounded-xl border border-dashed ink-border p-3 text-center"
              data-ui="workspace_add"
            >
              <FolderPlus size={16} strokeWidth={1.6} className="mx-auto mb-2 ink-text-faint" />
              <p className="text-[12px] leading-snug ink-text-muted">选择目录开始工作</p>
              <p className="mt-1 text-[10px] leading-relaxed ink-text-faint">
                授权后智能体可访问该目录下的文件
              </p>
              <button
                type="button"
                onClick={onAddWorkspace}
                className="ink-btn-secondary mt-2.5 flex h-7 w-full items-center justify-center gap-1 rounded-lg text-[11px]"
              >
                <FolderPlus size={11} strokeWidth={1.6} />
                添加工作区
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 底部设置（折叠态纯图标） */}
      <div className="shrink-0 border-t ink-border p-2">
        <button
          type="button"
          data-ui="nav_settings"
          onClick={onOpenSettings}
          title="设置"
          className={`flex w-full items-center gap-2.5 rounded-xl ink-text-muted transition-colors hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)] ${
            collapsed ? 'justify-center px-0 py-2.5' : 'px-2.5 py-2'
          }`}
        >
          <Settings2 size={17} strokeWidth={1.6} className="shrink-0" />
          {!collapsed && <span className="whitespace-nowrap text-[13px]">设置</span>}
        </button>
      </div>
    </aside>
  );
}
