/**
 * ui_spec 编辑器宿主视图（W4.1 / W4.2）：包装波 1 的 UiSpecEditor 组件。
 *
 * W4.1：inspect_ui（introspection snapshot_ui）→ setLiveSpec。
 * W4.2：产物 → ui_spec 补丁链 → 校验 → 落链 → 可回退。
 * 悬浮窗树编辑（拖拽增删仅同容器内排序 + 子容器追加；实时预览
 * + 主题 token 编辑 + 落链 / 回退）。
 *
 * 夹具仅 dev（VITE_USE_FIXTURE）；生产从 AppBackend.inspect_ui 拉取。
 */

import { useState, useCallback, useEffect } from 'react';
import { GitBranch, RotateCcw } from 'lucide-react';

import type { UISpec } from '@/renderer/uiSpecTypes';
import { validateUiSpec } from '@/renderer/validation';
import type { AppBackend } from '../../backend';
import { UiSpecEditor } from '@/components/ui_spec_editor';
import { Button } from '@/shared/ui/Button';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';

/** 回退操作结果 */
interface RevertResult {
  reverted: boolean;
  chain_version?: number;
}

interface UiEditorHostProps {
  backend: AppBackend;
  spec?: UISpec | null;
  onPatchApplied?: (spec: UISpec) => void;
  onRevert?: (result: RevertResult) => void;
}

export function UiEditorHost({ backend, spec: externalSpec, onPatchApplied, onRevert }: UiEditorHostProps) {
  const [liveSpec, setLiveSpec] = useState<UISpec | null>(externalSpec ?? null);
  const [loading, setLoading] = useState(!externalSpec);
  const [savePhase, setSavePhase] = useState<FeedbackPhase>('idle');
  const [revertPhase, setRevertPhase] = useState<FeedbackPhase>('idle');

  const refreshSpec = useCallback(async (): Promise<void> => {
    if (externalSpec) return;
    setLoading(true);
    try {
      const spec = await backend.getUiSpec();
      setLiveSpec(spec);
    } catch {
      setLiveSpec(null);
    } finally {
      setLoading(false);
    }
  }, [backend, externalSpec]);

  useEffect(() => {
    void refreshSpec();
  }, [refreshSpec]);

  if (loading) {
    return (
      <section className="ink-panel p-4" data-ui="ui_editor_loading">
        <div className="text-[11px] ink-text-faint">加载界面描述中…</div>
      </section>
    );
  }

  if (!liveSpec) {
    return (
      <section className="ink-panel p-4" data-ui="ui_editor_empty">
        <div className="flex items-center gap-2.5 text-[11px] ink-text-faint">
          <GitBranch size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
          <span>界面描述缺失或已损坏，已回退基线</span>
        </div>
      </section>
    );
  }

  const handleApply = (draft: UISpec): void => {
    const validation = validateUiSpec(draft);
    if (!validation.ok) {
      setSavePhase('fail');
      return;
    }
    setSavePhase('loading');
    Promise.resolve(
      backend
        .saveUiSpec(draft)
        .then((result) => {
          // 引擎回执分流：{applied:false}= 白名单/审批拒绝，不得乐观成功
          // （此前丢弃回执 → 未落链草稿被置为 live，编辑态与补丁链分叉）
          const applied = (result as { applied?: boolean })?.applied !== false;
          if (!applied) {
            setSavePhase('fail');
            return;
          }
          setLiveSpec(draft);
          setSavePhase('success');
          onPatchApplied?.(draft);
        })
        .catch(() => {
          setSavePhase('fail');
        }),
    );
  };

  const handleRevert = (): void => {
    setRevertPhase('loading');
    Promise.resolve(
      backend
        .revertUiSpec()
        .then((result) => {
          const reverted = (result as RevertResult)?.reverted === true;
          if (!reverted) {
            setRevertPhase('fail');
            return;
          }
          setRevertPhase('success');
          onRevert?.(result);
          refreshSpec();
        })
        .catch(() => {
          setRevertPhase('fail');
        }),
    );
  };

  return (
    <section className="ink-panel p-0" data-ui="ui_editor_host">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--ink-border)] px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <GitBranch size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
          <span className="text-[12px] font-semibold tracking-tight">界面树编辑器</span>
          <span className="text-[9px] font-mono ink-text-faint">
            v{liveSpec.version ?? 1} · {liveSpec.name}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="secondary" data-ui="ui_revert" onClick={handleRevert}>
            <RotateCcw size={10} strokeWidth={1.5} aria-hidden /> 回退
          </Button>
          <Feedback phase={revertPhase} okText="已回退到上一稳定版本" failText="回退失败" />
        </div>
      </div>

      <div className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] ink-text-muted">产物 → ui_spec 补丁链 → 校验 → 落链 → 可回退</span>
          <Feedback phase={savePhase} okText="已保存" failText="保存失败" />
        </div>

        <UiSpecEditor
          uiSpec={liveSpec}
          onApplyUiSpec={handleApply}
          embedded
        />
      </div>
    </section>
  );
}
