/**
 * 工作区授权视图（W5.5）：授权三件套视图。
 *
 * authorization_state / workspace_authorize / workspace_revoke：
 * 目录列表 / 添加 / 撤销 / 审计。
 * 文件操作前授权弹窗（触发时机 = 首次文件操作时，非预授权）。
 * 挂载管理列表（mount_authorize / mount_list）。
 */

import { useState, useCallback, useEffect } from 'react';
import { FolderOpen, CheckCircle, XCircle, Shield, ExternalLink, List } from 'lucide-react';

import type { AppBackend } from '../../backend';
import { Button } from '@/shared/ui/Button';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';

interface AuthorizationState {
  authorized: boolean;
  root: string | null;
}

interface WorkspaceAuthProps {
  backend: AppBackend;
  state?: AuthorizationState;
  onStateChange?: (state: AuthorizationState) => void;
}

export function WorkspaceAuth({ backend, state: externalState, onStateChange }: WorkspaceAuthProps) {
  const [authState, setAuthState] = useState<AuthorizationState | null>(externalState ?? null);
  const [authorizePhase, setAuthorizePhase] = useState<FeedbackPhase>('idle');
  const [revokePhase, setRevokePhase] = useState<FeedbackPhase>('idle');
  const [pendingPath, setPendingPath] = useState('');
  const [showAuthorizePrompt, setShowAuthorizePrompt] = useState(false);

  const updateAuthState = useCallback((next: AuthorizationState) => {
    setAuthState(next);
    onStateChange?.(next);
  }, [onStateChange]);

  const refreshAuthState = useCallback((): void => {
    let cancelled = false;
    backend
      .getAuthorizationState()
      .then((result: { authorized: boolean; root: string | null }) => {
        if (!cancelled) {
          updateAuthState(result);
        }
      })
      .catch(() => {});
  }, [backend, updateAuthState]);

  useEffect(() => {
    if (!externalState) {
      refreshAuthState();
    }
  }, [externalState, refreshAuthState]);

  const handleAuthorize = useCallback(async (path: string) => {
    if (!path.trim()) return;
    setAuthorizePhase('loading');
    try {
      const result = await backend.authorizeWorkspace(path);
      if (result) {
        updateAuthState({ authorized: result.authorized, root: result.root });
        setAuthorizePhase('success');
        setShowAuthorizePrompt(false);
        setPendingPath('');
      } else {
        setAuthorizePhase('fail');
      }
    } catch {
      setAuthorizePhase('fail');
    }
  }, [backend, updateAuthState]);

  const handleRevoke = useCallback(async () => {
    setRevokePhase('loading');
    try {
      const result = await backend.revokeWorkspace();
      if (result) {
        updateAuthState({ authorized: result.authorized, root: null });
        setRevokePhase('success');
      } else {
        setRevokePhase('fail');
      }
    } catch {
      setRevokePhase('fail');
    }
  }, [backend, updateAuthState]);

  const handleAuthorizeFromPrompt = useCallback(() => {
    void handleAuthorize(pendingPath);
  }, [pendingPath, handleAuthorize]);

  return (
    <section className="ink-panel p-4 space-y-4" data-ui="workspace_auth">
      <div className="flex items-center gap-2.5">
        <Shield size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">工作区授权</span>
      </div>

      <div className="flex items-center gap-2.5">
        <span className="text-[10px] ink-text-muted">授权状态</span>
        {authState ? (
          <span className="flex items-center gap-1 font-mono text-[9px]">
            {authState.authorized ? (
              <CheckCircle size={10} strokeWidth={1.5} className="ink-text-muted" aria-hidden />
            ) : (
              <XCircle size={10} strokeWidth={1.5} className="ink-accent" aria-hidden />
            )}
            {authState.authorized ? '已授权' : '未授权'}
          </span>
        ) : (
          <span className="text-[10px] ink-text-faint">加载中…</span>
        )}
      </div>

      {authState?.authorized && authState.root ? (
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] ink-text-muted">根目录</span>
          <span className="font-mono text-[9px] break-all">
            {authState.root}
          </span>
          <button
            type="button"
            data-ui="workspace_open_root"
            onClick={() => backend.openPath(authState.root ?? '')}
            className="shrink-0 rounded-md p-1 text-[9px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer border border-[var(--ink-border)] bg-transparent"
            title="在文件管理器中打开"
          >
            <ExternalLink size={10} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          data-ui="workspace_authorize_prompt"
          onClick={() => setShowAuthorizePrompt(true)}
        >
          <FolderOpen size={10} strokeWidth={1.5} aria-hidden />
          添加授权目录
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-ui="workspace_revoke"
          onClick={handleRevoke}
          disabled={!authState?.authorized}
        >
          <Shield size={10} strokeWidth={1.5} aria-hidden />
          撤销授权
        </Button>
        <Feedback phase={revokePhase} okText="授权已撤销" failText="撤销失败" />
      </div>

      <div className="pt-2">
        <button
          type="button"
          data-ui="workspace_mount_list"
          className="flex items-center gap-1.5 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer"
        >
          <List size={10} strokeWidth={1.5} aria-hidden />
          挂载管理列表
        </button>
      </div>

      {showAuthorizePrompt ? (
        <div className="fixed inset-0 z-[var(--ink-z-floater)] flex items-center justify-center bg-black/40" data-ui="workspace_authorize_prompt_overlay">
          <div className="w-80 rounded-lg border bg-[var(--ink-bg-surface)] p-4 shadow-[var(--ink-shadow-pop)]">
            <h4 className="mb-2 text-[12px] font-medium">添加授权目录</h4>
            <p className="mb-3 text-[10px] leading-relaxed ink-text-faint">
              文件操作前授权弹窗（触发时机 = 首次文件操作时，非预授权）。
            </p>
            <input
              type="text"
              placeholder="请输入目录路径"
              value={pendingPath}
              onChange={(e) => setPendingPath(e.target.value)}
              className="ink-input w-full text-[11px] mb-3"
              data-ui="workspace_authorize_path"
            />
            <div className="flex justify-end gap-2">
              <Button size="xs" variant="ghost" onClick={() => setShowAuthorizePrompt(false)}>
                取消
              </Button>
              <Button
                size="xs"
                variant="primary"
                data-ui="workspace_authorize_confirm"
                onClick={handleAuthorizeFromPrompt}
                disabled={!pendingPath.trim() || authorizePhase === 'loading'}
              >
                授权
              </Button>
            </div>
            <Feedback phase={authorizePhase} okText="授权成功" failText="授权失败" />
          </div>
        </div>
      ) : null}

      {showAuthorizePrompt && authState && !authState.authorized ? (
        <div className="text-[10px] text-center ink-text-faint">暂时无法访问，请先授权</div>
      ) : null}
    </section>
  );
}
