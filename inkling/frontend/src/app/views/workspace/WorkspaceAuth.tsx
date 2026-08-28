/**
 * 工作区授权视图（W5.5）：授权三件套视图。
 *
 * authorization_state / workspace_authorize / workspace_revoke：
 * 目录列表 / 添加 / 撤销 / 审计。
 * 文件操作前授权弹窗（触发时机 = 首次文件操作时，非预授权）。
 * 挂载管理列表（mount_authorize / mount_list）。
 *
 * 目录选择一律走系统原生文件选择器（Tauri dialog），不做手动路径输入。
 */

import { useState, useCallback, useEffect } from 'react';
import { FolderOpen, CheckCircle, XCircle, Shield, ExternalLink, List } from 'lucide-react';

import type { AppBackend } from '../../backend';
import { Button } from '@/shared/ui/Button';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';

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

  /** 系统原生目录选择器 → 授权（宿主不可用时静默失败，保持现状）。 */
  const handleAuthorizeFromPicker = useCallback(async () => {
    const tauri = createTauriInvoker();
    if (!tauri) return;
    let picked: string | null = null;
    try {
      picked = (await tauri.invoke('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: '选择工作区目录' },
      })) as string | null;
    } catch {
      return;
    }
    if (!picked) return;
    setAuthorizePhase('loading');
    try {
      const result = await backend.authorizeWorkspace(picked);
      if (result) {
        updateAuthState({ authorized: result.authorized, root: result.root });
        setAuthorizePhase('success');
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
          onClick={() => void handleAuthorizeFromPicker()}
          disabled={authorizePhase === 'loading'}
        >
          <FolderOpen size={10} strokeWidth={1.5} aria-hidden />
          {authorizePhase === 'loading' ? '选择中…' : '添加授权目录'}
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
        <Feedback phase={authorizePhase} okText="授权成功" failText="授权失败" />
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
    </section>
  );
}
