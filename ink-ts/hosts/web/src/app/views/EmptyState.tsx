import type { LucideIcon } from 'lucide-react';

import styles from './EmptyState.module.css';

/** 空态：线条风 SVG 插画 + 一行文案 + ≤1 个直达入口（空态统一规格）。 */
export function EmptyState({
  icon: Icon,
  text,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className={styles.empty} data-testid="w3-empty">
      <Icon strokeWidth={1.5} aria-hidden="true" />
      <div className={styles.emptyText}>{text}</div>
      {actionLabel && onAction && (
        <button type="button" className={styles.emptyLink} onClick={onAction} data-testid="w3-empty-action">
          {actionLabel}
        </button>
      )}
    </div>
  );
}
