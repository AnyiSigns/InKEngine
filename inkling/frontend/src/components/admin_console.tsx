/**
 * 管理台视图：应用注册表（三来源分组 + 卸载/停用/重置动作）。
 *
 * 出厂基线条目：不可卸载，可停用（移出引用）/ 重置（补丁链清空）；
 * MCP 挂载 / AI 自写条目：可卸载（链上产物可回退）。每条目展示
 * 名称/类型/版本/来源/状态/最近变化/关联补丁链 ID。数据经可注入
 * store 抽象（默认夹具，宿主接线引擎 registry）。
 */

import { useState } from 'react';
import { Archive, Lock, RotateCcw, Trash2 } from 'lucide-react';

import type { AppRegistryEntry, AppRegistryStore } from '@/shared/registry/appRegistry';
import { MemoryAppRegistryStore, REGISTRY_SOURCE_LABELS, REGISTRY_TYPE_LABELS } from '@/shared/registry/appRegistry';
import { formatTimeCompact } from '@/shared/format_helpers';
import { cn } from '@/shared/cn';
import { Button } from '@/shared/ui/Button';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';

interface AdminConsoleProps {
  bindValue?: unknown;
  registryStore?: AppRegistryStore;
  /** 备份/恢复向导入口（管理台导出/恢复入口接线） */
  onOpenBackupWizard?: (mode: 'export' | 'restore') => void;
}

export function AdminConsole({ registryStore, onOpenBackupWizard }: AdminConsoleProps) {
  const store = registryStore ?? new MemoryAppRegistryStore([]);
  return <AdminConsoleInner store={store} onOpenBackupWizard={onOpenBackupWizard} />;
}

function AdminConsoleInner({ store, onOpenBackupWizard }: { store: AppRegistryStore; onOpenBackupWizard?: (mode: 'export' | 'restore') => void }) {
  const [phase, setPhase] = useState<FeedbackPhase>('idle');
  const entries = store.list();
  const groupsBySource = (['baseline', 'mcp', 'ai'] as const)
    .map((source) => ({ source, entries: entries.filter((entry) => entry.source === source) }))
    .filter((group) => group.entries.length > 0);

  const run = (action: () => void): void => {
    action();
    setPhase('success');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="text-[11px] ink-text-muted">应用注册表（{entries.length} 条）</div>
        <Feedback phase={phase} okText="已应用" failText="操作失败" className="ml-auto" />
        <Button size="sm" variant="secondary" data-ui="admin_backup_entry" onClick={() => onOpenBackupWizard?.('export')}>
          <Archive size={11} strokeWidth={1.6} /> 导出数据
        </Button>
      </div>
      {groupsBySource.map((group) => (
        <section key={group.source} data-ui={`registry_group_${group.source}`}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className={cn('ink-chip py-px text-[9px]', group.source === 'baseline' && 'ink-text-muted')}>
              {REGISTRY_SOURCE_LABELS[group.source]}
            </span>
            <span className="text-[10px] ink-text-faint">
              {group.source === 'baseline' ? '不可卸载 · 可停用/重置' : '可卸载（随补丁链可回退）'}
            </span>
          </div>
          <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
            {group.entries.map((entry) => (
              <AdminRow
                key={entry.id}
                entry={entry}
                onDisable={() => run(() => store.disable(entry.id))}
                onReset={() => run(() => store.reset(entry.id))}
                onUninstall={() => run(() => store.uninstall(entry.id))}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function AdminRow({
  entry,
  onDisable,
  onReset,
  onUninstall,
}: {
  entry: AppRegistryEntry;
  onDisable: () => void;
  onReset: () => void;
  onUninstall: () => void;
}) {
  const isBaseline = entry.source === 'baseline';
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5" data-ui={`registry_entry_${entry.id}`} data-status={entry.status}>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[var(--ink-font-xs)] font-medium">{entry.name}</span>
          <span className="ink-chip font-mono text-[9px] ink-text-faint">{REGISTRY_TYPE_LABELS[entry.type]}</span>
          <span className="ink-chip font-mono text-[9px] ink-text-faint">v{entry.version}</span>
          {entry.status === 'disabled' && <span className="ink-chip py-px text-[9px] ink-text-faint">已停用</span>}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] ink-text-faint">
          <span>来源 {REGISTRY_SOURCE_LABELS[entry.source]}</span>
          <span>· 最近变更 {formatTimeCompact(entry.changedAt)}</span>
          {entry.patchChainId && <span className="font-mono">· 补丁链 {entry.patchChainId}</span>}
        </span>
        {entry.description && <span className="mt-0.5 block truncate text-[10px] ink-text-muted">{entry.description}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {isBaseline ? (
          <>
            <Button size="xs" variant="ghost" data-ui={`registry_disable_${entry.id}`} onClick={onDisable}>
              {entry.status === 'active' ? <Archive size={10} strokeWidth={1.6} /> : <Lock size={10} strokeWidth={1.6} />}
              {entry.status === 'active' ? '停用' : '启用'}
            </Button>
            <Button size="xs" variant="ghost" data-ui={`registry_reset_${entry.id}`} onClick={onReset}>
              <RotateCcw size={10} strokeWidth={1.6} /> 重置
            </Button>
          </>
        ) : (
          <Button size="xs" variant="ghost" data-ui={`registry_uninstall_${entry.id}`} onClick={onUninstall}>
            <Trash2 size={10} strokeWidth={1.6} /> 卸载
          </Button>
        )}
      </span>
    </div>
  );
}
