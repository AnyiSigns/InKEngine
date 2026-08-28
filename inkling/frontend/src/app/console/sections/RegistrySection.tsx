import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Play, RotateCcw, Square } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { invokeOp } from '../../shared/invokeOp';

export interface RegistryEntry {
  name: string;
  type: string;
  version: string;
  source: string;
  status: 'active' | 'disabled';
  last_change: string;
}

export interface RegistryTable {
  id: string;
  label: string;
  entries: RegistryEntry[];
}

export interface RegistryData {
  tables: RegistryTable[];
}

export function RegistrySection() {
  const [data, setData] = useState<RegistryData | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['tools', 'components', 'models', 'inspect']));

  useEffect(() => {
    void load();
  }, []);

  const load = async () => {
    const tools = await invokeOp<{ tools: Array<{ tool: string; zh: string; group: string; auto_approvable?: boolean }> }>('tools_snapshot', {});
    const components = await invokeOp<{ artifacts: Array<{ name: string; url: string; hash: string; version: string; renderer_key?: string }> }>('components_manifest', {});
    const models = await invokeOp<{ profiles: Array<{ id: string; name: string; tier: string; occupancy: number; limit: number; multimodal?: boolean }> }>('model_archive_snapshot', {});
    const inspect = await invokeOp<{ tools: Array<{ name: string; description: string }> }>('inspect_tools', {});

    const tables: RegistryTable[] = [
      {
        id: 'tools',
        label: '工具快照',
        entries: (tools?.tools ?? []).map((t: { tool: string; zh: string; group: string }) => ({
          name: t.tool,
          type: t.group,
          version: '—',
          source: '声明式',
          status: 'active',
          last_change: t.zh,
        })),
      },
      {
        id: 'components',
        label: '组件清单',
        entries: (components?.artifacts ?? []).map((c: { name: string; url: string; hash: string; version: string }) => ({
          name: c.name,
          type: '组件',
          version: c.version,
          source: c.url,
          status: 'active',
          last_change: c.hash.slice(0, 8),
        })),
      },
      {
        id: 'models',
        label: '模型档案',
        entries: (models?.profiles ?? []).map((m: { id: string; name: string; tier: string; occupancy: number; limit: number; multimodal?: boolean }) => ({
          name: m.name,
          type: m.tier,
          version: '—',
          source: m.multimodal ? '多模态' : '标准',
          status: 'active',
          last_change: `${m.occupancy}/${m.limit}`,
        })),
      },
      {
        id: 'inspect',
        label: '内省工具',
        entries: (inspect?.tools ?? []).map((t: { name: string; description: string }) => ({
          name: t.name,
          type: '内省',
          version: '—',
          source: '内省',
          status: 'active',
          last_change: t.description,
        })),
      },
    ];

    setData({ tables });
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div data-ui="registry_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">注册表</h3>
        <Button size="xs" variant="ghost" onClick={() => void load()}>刷新</Button>
      </div>

      {!data ? (
        <div className="text-[12px] text-[var(--ink-text-faint)]">加载中...</div>
      ) : (
        <div className="flex flex-col gap-3">
          {data.tables.map((table) => (
            <div key={table.id} data-ui={`registry_table_${table.id}`}>
              <button
                type="button"
                onClick={() => toggleExpand(table.id)}
                className="flex w-full items-center gap-1 text-[11px] font-medium text-[var(--ink-text-muted)] cursor-pointer"
              >
                {expanded.has(table.id) ? <ChevronDown size={12} strokeWidth={1.6} /> : <ChevronRight size={12} strokeWidth={1.6} />}
                {table.label} ({table.entries.length})
              </button>

              {expanded.has(table.id) && table.entries.length > 0 && (
                <div className="mt-1 rounded border border-[var(--ink-border)] overflow-hidden">
                  <table className="w-full text-left text-[10px]">
                    <thead>
                      <tr className="text-[var(--ink-text-faint)] border-b border-[var(--ink-border)]">
                        <th className="px-2 py-1 font-medium">名称</th>
                        <th className="px-2 py-1 font-medium">类型</th>
                        <th className="px-2 py-1 font-medium">版本</th>
                        <th className="px-2 py-1 font-medium">来源</th>
                        <th className="px-2 py-1 font-medium">状态</th>
                        <th className="px-2 py-1 font-medium">最近变化</th>
                        <th className="px-2 py-1 font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.entries.map((entry, i) => (
                        <tr key={`${entry.name}-${i}`} className="border-b border-[var(--ink-border)] last:border-0">
                          <td className="px-2 py-1 font-medium text-[var(--ink-text-base)]">{entry.name}</td>
                          <td className="px-2 py-1 text-[var(--ink-text-muted)]">{entry.type}</td>
                          <td className="px-2 py-1 text-[var(--ink-text-faint)]">{entry.version}</td>
                          <td className="px-2 py-1 text-[var(--ink-text-faint)] truncate max-w-24">{entry.source}</td>
                          <td className="px-2 py-1">
                            <span className={entry.status === 'active' ? 'text-emerald-600' : 'text-[var(--ink-text-faint)]'}>
                              {entry.status === 'active' ? '启用' : '停用'}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-[var(--ink-text-faint)] truncate max-w-32">{entry.last_change}</td>
                          <td className="px-2 py-1">
                            <div className="flex gap-0.5">
                              <Button size="xs" variant="ghost">
                                {entry.status === 'active' ? <Square size={9} strokeWidth={1.6} /> : <Play size={9} strokeWidth={1.6} />}
                              </Button>
                              <Button size="xs" variant="ghost">
                                <RotateCcw size={9} strokeWidth={1.6} />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {expanded.has(table.id) && table.entries.length === 0 && (
                <div className="mt-1 rounded border border-dashed border-[var(--ink-border)] px-3 py-4 text-center text-[10px] text-[var(--ink-text-faint)]">
                  暂无数据
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
