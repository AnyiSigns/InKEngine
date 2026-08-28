import { useEffect, useState } from 'react';
import { Download, Lock } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { invokeOp } from '../../shared/invokeOp';

export interface AuditEntry {
  ts: number;
  action: string;
  decision_source: string;
  trace_id: string;
}

export interface AuditLog {
  entries: AuditEntry[];
}

export function AuditSection() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    void load();
  }, []);

  const load = async () => {
    const result = await invokeOp<AuditLog>('set_audit', {});
    setEntries(result?.entries ?? []);
  };

  const handleExport = () => {
    const lines = entries.map((e) =>
      `${new Date(e.ts * 1000).toLocaleString()}\t${e.action}\t${e.decision_source}\t${e.trace_id}`,
    );
    const header = '时间\t动作\t决策来源\ttrace_id\n';
    const content = header + lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'audit_export.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div data-ui="audit_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Lock size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">审计</h3>
        <Button size="xs" variant="secondary" onClick={handleExport}>
          <Download size={10} strokeWidth={1.6} />
          导出
        </Button>
      </div>

      {entries.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          暂无审计记录
        </div>
      ) : (
        <div className="rounded border border-[var(--ink-border)] overflow-hidden">
          <table className="w-full text-left text-[10px]">
            <thead>
              <tr className="text-[var(--ink-text-faint)] border-b border-[var(--ink-border)]">
                <th className="px-2 py-1 font-medium">时间</th>
                <th className="px-2 py-1 font-medium">动作</th>
                <th className="px-2 py-1 font-medium">决策来源</th>
                <th className="px-2 py-1 font-medium">trace_id</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={`${entry.trace_id}-${i}`} className="border-b border-[var(--ink-border)] last:border-0">
                  <td className="px-2 py-1 text-[var(--ink-text-muted)]">
                    {new Date(entry.ts * 1000).toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-[var(--ink-text-base)]">{entry.action}</td>
                  <td className="px-2 py-1 text-[var(--ink-text-faint)]">{entry.decision_source}</td>
                  <td className="px-2 py-1 font-mono text-[var(--ink-text-faint)]">{entry.trace_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
