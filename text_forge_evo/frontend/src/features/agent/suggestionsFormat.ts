/**
 * 创作建议格式化（实时 SSE 与历史回放共用同一实现，防文案漂移）。
 */

/** 建议分级/类型 → 展示前缀注册表。 */
const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const SEVERITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };
const TYPE_LABEL: Record<string, string> = {
  summary_missing: '章节缺少摘要',
  foreshadowing_due: '伏笔待回收',
  foreshadowing_stalled: '伏笔停滞待办',
  plot_thread_stalled: '情节线停滞',
  pacing_imbalance: '节奏失衡',
};

export function formatSuggestions(items: Array<Record<string, unknown>> | undefined): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = [...items]
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[String(a?.severity || '')] ?? 9) -
        (SEVERITY_ORDER[String(b?.severity || '')] ?? 9),
    )
    .map((it) => {
      const label = TYPE_LABEL[String(it?.type || '')] || String(it?.type || '建议');
      const message = String(it?.message || it?.suggestion || '');
      const sev = SEVERITY_LABEL[String(it?.severity || '')]
        ? `[${SEVERITY_LABEL[String(it?.severity || '')]}] `
        : '';
      return `· ${sev}${label}：${message}`;
    })
    .join('\n');
  return lines ? `**创作建议**\n${lines}` : '';
}
