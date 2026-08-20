/**
 * 文件域面板：挂载点管理（本地文件访问授权）。
 *
 * 挂载点模型：AI 只见显式授权的挂载点，磁盘其余部分 fail-closed
 * 不可见。面板 = 用户授权动作（注册/撤销），路径文本输入（浏览器
 * 拿不到绝对路径；桌面壳落地后走系统目录选择对话框）；目录浏览
 * 仅限挂载点内（read 级即满足），越界 403。
 */

import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';

import { registerComponent } from '@/registry/componentRegistry';
import { fetchJson } from '@/shared/api';

interface MountView {
  id: string;
  path: string;
  level: string;
  app: string;
  note?: string;
}

interface BrowseView {
  path: string;
  mount: MountView;
  entries: Array<{ name: string; type: string; size: number }>;
}

const LEVEL_LABELS: Record<string, string> = {
  read: '读',
  write: '写',
  execute: '执行',
};

export function FilesPanel() {
  const [mounts, setMounts] = useState<MountView[]>([]);
  const [failed, setFailed] = useState(false);
  const [path, setPath] = useState('');
  const [level, setLevel] = useState('read');
  const [browsePath, setBrowsePath] = useState('');
  const [browse, setBrowse] = useState<BrowseView | null>(null);
  const [browseError, setBrowseError] = useState('');
  const [banner, setBanner] = useState('');

  const refresh = useCallback(() => {
    void fetchJson<{ mounts: MountView[] }>('/api/files/mounts')
      .then((data) => setMounts(data.mounts))
      .catch(() => setFailed(true));
  }, []);

  useEffect(refresh, [refresh]);

  const register = () => {
    if (!path.trim()) return;
    void fetch('/api/files/mounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path.trim(), level }),
    })
      .then(async (resp) => {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.detail || '注册失败');
        setBanner(`已授权挂载点：${data.path}`);
        setPath('');
        refresh();
      })
      .catch((err: Error) => setBanner(`注册失败：${err.message}`));
  };

  const revoke = (mountId: string) => {
    void fetch(`/api/files/mounts/${mountId}`, { method: 'DELETE' })
      .then(async (resp) => {
        if (!resp.ok) throw new Error('撤销失败');
        setBanner('挂载点已撤销（留痕可审计）');
        refresh();
      })
      .catch((err: Error) => setBanner(err.message));
  };

  const doBrowse = (target?: string) => {
    const pathValue = (target ?? browsePath).trim();
    if (!pathValue) return;
    setBrowseError('');
    void fetchJson<BrowseView>(`/api/files/browse?path=${encodeURIComponent(pathValue)}`)
      .then((data) => {
        setBrowse(data);
        setBrowsePath(data.path);
      })
      .catch(async (err) => {
        setBrowse(null);
        setBrowseError(String(err));
      });
  };

  if (failed) {
    return (
      <div className="rounded-md border border-dashed border-destructive/25 px-4 py-6 text-center text-[11px] text-destructive/60">
        挂载点读取失败（观察通道不可用）
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FolderOpen size={12} strokeWidth={1.6} className="text-sky-500/80" />
        <span className="text-[11px] font-medium text-foreground/60">文件访问授权</span>
        <span className="ml-auto text-[10px] text-foreground/30 tabular-nums">
          {mounts.length} 个挂载点
        </span>
      </div>

      {banner && (
        <div className="rounded-md border border-sky-500/25 bg-sky-500/10 px-2.5 py-1.5 text-[10px] text-sky-500/90">
          {banner}
        </div>
      )}

      <div className="rounded-md border border-border/60 bg-card p-2">
        <div className="text-[10px] text-muted-foreground/60">
          授权目录（磁盘其余部分对 AI fail-closed 不可见）
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && register()}
            placeholder="目录路径，如 D:\Novels"
            data-ui="mount_path_input"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] outline-none focus:border-foreground/30 placeholder:text-muted-foreground/40"
          />
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            data-ui="mount_level_select"
            className="rounded border border-border bg-background px-1 py-1 text-[11px] outline-none"
          >
            <option value="read">读</option>
            <option value="write">写</option>
            <option value="execute">执行</option>
          </select>
          <button
            onClick={register}
            disabled={!path.trim()}
            data-ui="btn_mount_add"
            title="注册挂载点"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-foreground/15 bg-foreground/10 text-foreground cursor-pointer transition-colors disabled:opacity-40"
          >
            <Plus size={11} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {mounts.length === 0 ? (
        <div className="rounded-md border border-dashed border-foreground/15 px-3 py-4 text-center text-[11px] text-muted-foreground/50">
          尚无挂载点（「帮我整理 D:\Downloads」会先请求授权）
        </div>
      ) : (
        <div className="space-y-1.5">
          {mounts.map((mount) => (
            <div
              key={mount.id}
              className="rounded-md border border-foreground/[0.08] bg-foreground/[0.03] px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-sky-500/15 px-1 py-px text-[9px] text-sky-500/80 font-mono">
                  {LEVEL_LABELS[mount.level] || mount.level}
                </span>
                <span className="truncate text-[11px] text-foreground/80 font-mono">
                  {mount.path}
                </span>
                <span className="shrink-0 rounded bg-foreground/10 px-1 py-px text-[9px] text-foreground/45">
                  {mount.app}
                </span>
                <button
                  onClick={() => doBrowse(mount.path)}
                  title="浏览目录"
                  className="ml-auto shrink-0 rounded px-1 py-px text-[9px] text-sky-500/80 hover:bg-sky-500/10 cursor-pointer"
                >
                  浏览
                </button>
                <button
                  onClick={() => revoke(mount.id)}
                  title="撤销授权"
                  className="shrink-0 rounded px-1 py-px text-[9px] text-destructive/70 hover:bg-destructive/10 cursor-pointer"
                >
                  撤销
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-border/60 bg-card p-2">
        <div className="text-[10px] text-muted-foreground/60">目录浏览（限挂载点内）</div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            value={browsePath}
            onChange={(e) => setBrowsePath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doBrowse()}
            placeholder="挂载点内路径"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] outline-none focus:border-foreground/30 placeholder:text-muted-foreground/40 font-mono"
          />
          <button
            onClick={() => doBrowse()}
            data-ui="btn_browse"
            title="浏览"
            className="shrink-0 rounded border border-foreground/15 px-2 py-1 text-[10px] text-foreground/70 hover:bg-foreground/10 cursor-pointer"
          >
            浏览
          </button>
        </div>
        {browseError && (
          <div className="mt-1.5 rounded border border-destructive/25 bg-destructive/10 px-2 py-1 text-[10px] text-destructive/80">
            {browseError}
          </div>
        )}
        {browse && (
          <div className="mt-1.5 max-h-44 overflow-y-auto rounded border border-foreground/10">
            {browse.entries.length === 0 ? (
              <div className="px-2 py-2 text-[10px] text-muted-foreground/40">空目录</div>
            ) : (
              browse.entries.map((entry) => (
                <button
                  key={entry.name}
                  onClick={() => entry.type === 'dir' && doBrowse(`${browse.path}\\${entry.name}`)}
                  disabled={entry.type !== 'dir'}
                  className="flex w-full items-center gap-2 px-2 py-1 text-left text-[10px] hover:bg-foreground/5 cursor-pointer disabled:cursor-default"
                >
                  <span className="text-foreground/40">{entry.type === 'dir' ? '📁' : '📄'}</span>
                  <span className="truncate text-foreground/75">{entry.name}</span>
                  {entry.type === 'file' && (
                    <span className="ml-auto shrink-0 text-[9px] text-foreground/30 tabular-nums">
                      {entry.size} B
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function FilesPanelHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="mb-2 flex items-center">
      <span className="text-[11px] font-medium text-foreground/60">文件授权</span>
      <button
        onClick={onClose}
        className="ml-auto flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 cursor-pointer"
        title="关闭面板"
      >
        <X size={11} strokeWidth={1.6} />
      </button>
    </div>
  );
}

/**
 * 注册进动态组件表：布局 JSON 引用 type=files_panel 即渲染（与对话
 * 面板同走 boot 渲染器——同一渲染器承载多形态，形态边界统一落位）。
 */
function FilesPanelEntry(_props: Record<string, unknown>) {
  return <FilesPanel />;
}

registerComponent('files_panel', { load: () => FilesPanelEntry });
