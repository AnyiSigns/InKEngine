import { useEffect, useState } from 'react';
import { Database, Download, FileText, Info, Shield } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { invokeOp } from '../../shared/invokeOp';

export interface AboutInfo {
  version: string;
  engine_compat: string;
  contract_manifest: Array<{ name: string; version: string }>;
  data_sovereignty: string;
}

export function AboutSection() {
  const [info, setInfo] = useState<AboutInfo | null>(null);

  useEffect(() => {
    void load();
  }, []);

  const load = async () => {
    const result = await invokeOp<AboutInfo>('about_info', {});
    setInfo(result ?? {
      version: '0.1.0',
      engine_compat: 'ink_engine 0.1',
      contract_manifest: [],
      data_sovereignty: '所有数据本地存储，不经第三方服务器',
    });
  };

  const handleExportAudit = () => {
    invokeOp('set_audit_export', {});
  };

  return (
    <div data-ui="about_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Info size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">关于</h3>
      </div>

      <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
        <div className="flex items-center gap-2 text-[11px]">
          <FileText size={12} strokeWidth={1.6} className="text-[var(--ink-text-faint)]" />
          <span className="text-[var(--ink-text-muted)]">版本：</span>
          <span className="text-[var(--ink-text-base)]">{info?.version}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <Database size={12} strokeWidth={1.6} className="text-[var(--ink-text-faint)]" />
          <span className="text-[var(--ink-text-muted)]">引擎兼容：</span>
          <span className="text-[var(--ink-text-base)]">{info?.engine_compat}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <Shield size={12} strokeWidth={1.6} className="text-[var(--ink-text-faint)]" />
          <span className="text-[var(--ink-text-muted)]">数据主权：</span>
          <span className="text-[var(--ink-text-base)]">{info?.data_sovereignty}</span>
        </div>
      </div>

      {info?.contract_manifest && info.contract_manifest.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] text-[var(--ink-text-muted)]">契约清单</div>
          {info.contract_manifest.map((c) => (
            <div key={c.name} className="text-[10px] text-[var(--ink-text-faint)]">
              {c.name} @ {c.version}
            </div>
          ))}
        </div>
      )}

      <Button size="sm" variant="secondary" onClick={handleExportAudit}>
        <Download size={12} strokeWidth={1.6} />
        审计导出
      </Button>
    </div>
  );
}
