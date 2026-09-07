/**
 * 时间短格式（展示层辅助）：管理台「最近变化」等时间戳的人读化。
 * 无副作用纯函数；今日内仅时间，跨日带日期。
 */

export function formatTimeCompact(at: number): string {
  if (!at || !Number.isFinite(at)) return '—';
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  const now = new Date();
  const sameDay = time.toDateString() === now.toDateString();
  return sameDay ? clock : `${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${clock}`;
}
