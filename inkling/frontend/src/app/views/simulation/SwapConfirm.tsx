import { Check, X } from 'lucide-react';

import { Button } from '@/shared/ui/Button';

/** 换选确认浮层：换选到分支 N + 将创建新检查点 + 确认/取消/取消选择 三按钮。 */
export function SwapConfirm({
  branch,
  onConfirm,
  onCancel,
  onClear,
}: {
  branch: number;
  onConfirm: () => void;
  onCancel: () => void;
  onClear: () => void;
}) {
  return (
    <div className="w3-floater-backdrop" data-testid="swap-confirm" role="dialog" aria-modal="true" aria-label="换选确认">
      <div className="w3-floater">
        <div className="w3-drawer-head">
          <strong>换选到分支 {branch}</strong>
        </div>
        <div className="w3-muted">将创建新检查点（可回退）。</div>
        <div className="w3-floater-actions">
          <div className="w3-stack-v">
            <Button variant="ghost" onClick={onClear} data-testid="swap-clear">
              取消选择
            </Button>
            <Button variant="ghost" onClick={onCancel} data-testid="swap-cancel">
              <X size={14} strokeWidth={1.5} /> 取消
            </Button>
          </div>
          <Button variant="primary" onClick={onConfirm} data-testid="swap-confirm-btn">
            <Check size={14} strokeWidth={1.5} /> 确认
          </Button>
        </div>
      </div>
    </div>
  );
}
