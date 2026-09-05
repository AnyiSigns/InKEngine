/**
 * 通用状态 → 语义色调类（running/pending/fail 词汇表，单源映射）。
 * 域特殊状态（补丁链 proposed/applied/reverted、孵化 stage）由各面板自映射。
 */

export function statusTone(status: string): string {
  if (status === 'error' || status === 'failed' || status === 'blocked') return 'ink-accent';
  if (status === 'running' || status === 'pending') return 'ink-text-muted';
  return 'ink-text-faint';
}
