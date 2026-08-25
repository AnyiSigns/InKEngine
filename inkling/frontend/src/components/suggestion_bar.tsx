/**
 * 情境建议条：规则驱动的主动建议展示（signal_detected 同态）。
 *
 * bindValue 取 suggestion.scan 产出：命中情境触发规则的建议清单
 * （rule_id / message / severity）。纯展示、无副作用，无建议时回落空态；
 * 建议条形态（顶部细长条），点击暂不接动作（宿主侧按规则 id 派发）。
 */

interface Suggestion {
  rule_id?: string;
  message?: string;
  severity?: string;
}

const SEVERITY_CLASS: Record<string, string> = {
  error: 'ink-border-red text-red-600',
  warning: 'ink-border-amber text-amber-600',
  info: 'ink-border ink-text-muted',
};

export function SuggestionBar({ bindValue }: { bindValue?: { suggestions?: Suggestion[] } | null }) {
  const suggestions = bindValue?.suggestions ?? [];

  if (suggestions.length === 0) {
    return (
      <div data-ui="suggestion_bar" className="px-3 py-1 text-[11px] ink-text-muted">
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
          className={`flex items-center gap-2 rounded border px-2 py-1 ${
            SEVERITY_CLASS[s.severity ?? 'info'] ?? SEVERITY_CLASS.info
          }`}
        >
          <span className="font-medium">{s.rule_id ?? '建议'}</span>
          <span className="truncate">{s.message}</span>
        </div>
      ))}
    </div>
  );
}
