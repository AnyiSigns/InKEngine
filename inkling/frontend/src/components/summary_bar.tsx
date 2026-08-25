/**
 * 摘要条（深看顶部收敛带）：把事件流 / 快照收敛成一行人话摘要。
 *
 * 绑定通道把动态数据（events.* 事件数组 / inspect_* 快照对象）注入，组件
 * 做轻量归约——数组按类型计数、对象给快照就绪态、空态给回落文案。深看
 * （演化/推演/来源）据此把密集散点收成一条摘要，细节留待分组卡展开。
 * 纯展示、无副作用，空数据不崩。
 */

interface SummaryBarProps {
  label?: string;
  empty?: string;
  bindValue?: unknown;
}

function countByType(events: Array<Record<string, unknown>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const raw = typeof event?.type === 'string' ? event.type : 'unknown';
    const key = raw.replace(/^events\./, '');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function SummaryBar({ label, empty = '暂无动态', bindValue }: SummaryBarProps) {
  let text: string;
  if (Array.isArray(bindValue)) {
    if (bindValue.length === 0) {
      text = empty;
    } else {
      const parts = Object.entries(countByType(bindValue as Array<Record<string, unknown>>)).map(
        ([type, count]) => `${type} ${count}`,
      );
      text = `动态 ${bindValue.length} 条 · ${parts.join(' · ')}`;
    }
  } else if (bindValue && typeof bindValue === 'object') {
    text = '快照就绪';
  } else {
    text = empty;
  }

  return (
    <div
      data-ui="summary_bar"
      className="flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ink-border ink-text-muted"
    >
      {label ? <span className="font-medium ink-text-base">{label}</span> : null}
      <span className="truncate">{text}</span>
    </div>
  );
}
