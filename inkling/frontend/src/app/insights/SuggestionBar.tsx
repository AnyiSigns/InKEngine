import { cn } from '@/shared/cn';
import type { SuggestionScan } from './backend';

const SEVERITY_CLASS: Record<string, string> = {
  error: 'border-[var(--ink-accent-border)] text-[var(--ink-accent-approval)]',
  warning: 'border-amber-500/40 text-amber-600',
  info: 'border-[var(--ink-border)] text-[var(--ink-text-muted)]',
};

export function SuggestionBar({ data }: { data?: SuggestionScan | null }) {
  const suggestions = data?.suggestions ?? [];

  if (suggestions.length === 0) {
    return (
      <div data-ui="suggestion_bar" className="px-3 py-1 text-[11px] text-[var(--ink-text-muted)]">
        暂无主动建议
      </div>
    );
  }

  return (
    <div data-ui="suggestion_bar" className="flex flex-col gap-1 px-3 py-1 text-[11px]">
      {suggestions.map((s, i) => (
        <div
          key={`s-${i}`}
          data-rule={s.rule_id ?? 'unknown'}
          data-severity={s.severity ?? 'info'}
          className={cn(
            'flex items-center gap-2 rounded border px-2 py-1',
            SEVERITY_CLASS[s.severity ?? 'info'] ?? SEVERITY_CLASS.info,
          )}
        >
          <span className="font-medium">{s.rule_id ?? '建议'}</span>
          <span className="truncate">{s.message}</span>
        </div>
      ))}
    </div>
  );
}
