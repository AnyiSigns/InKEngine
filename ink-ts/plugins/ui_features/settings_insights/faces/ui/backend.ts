import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';

/** set_audit 集合记录（append-only 干预/自修改留痕的原始形态）。 */
export interface AuditRecord {
  type?: string;
  kind?: string;
  ts?: number;
  domain?: string;
  reason?: string | null;
  action?: string | null;
  review_tier?: string | null;
  candidate_id?: string | null;
  src_type?: string | null;
  dst_type?: string | null;
  tool?: string | null;
  trace_id?: string | null;
  thread_id?: string | null;
  [key: string]: unknown;
}

/** 时间线条目（历史铺底与实时事件统一形态）。 */
export interface TimelineEntry {
  id: string;
  ts: number; // epoch 毫秒
  type: string;
  title: string;
  detail?: string;
  raw: AuditRecord;
  source: 'history' | 'live';
}

/** 审计流水（只读）：读取 set_audit 集合（audit.list → {records} 窗口）。
 *  显式传 adapter = 消费壳注入的共享实例；缺省（测试/独立挂载）回落自建。 */
export async function listAudit(backendAdapter?: BackendAdapter): Promise<AuditRecord[] | null> {
  const backend = backendAdapter ?? createBackend();
  if (!backend.available) return null;
  try {
    const result = await backend.auditList();
    return Array.isArray(result?.records) ? (result.records as AuditRecord[]) : null;
  } catch {
    return null;
  }
}
