/**
 * 已注册/已挂载组件清单视图（与 MCP 市场分离后的组件落点）。
 *
 * 数据源 = 宿主 components_manifest（补丁链为权威）：agent 自写组件
 * （ARTIFACT 补丁 meta.component）与外部 URL 组件（dsh 形态直引）经
 * 落链登记，此处只读展示清单，不做市场浏览/挂载。挂载/注册动作在
 * 补丁链侧，本视图每次挂载刷新注册表（artifactLoader 即插即显）。
 * 空态「暂无已挂载组件」。
 */

import { useEffect, useState } from 'react';
import { Boxes, PackageOpen } from 'lucide-react';

import type { AppBackend } from '../../backend';
import type { AppArtifactEntry } from '../../types';

interface ComponentRegistryProps {
  backend: AppBackend;
}

export function ComponentRegistry({ backend }: ComponentRegistryProps) {
  const [entries, setEntries] = useState<AppArtifactEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        await backend.refreshComponentManifest();
        const list = await backend.getComponentsManifest();
        if (alive) setEntries(list);
      } catch {
        // 宿主不可用 = 空清单（既有组件照常）
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [backend]);

  return (
    <section className="ink-panel p-4" data-ui="component_registry">
      <div className="flex items-center gap-2.5">
        <Boxes size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">已注册组件</span>
        <span className="ml-auto text-[10px] ink-text-faint">
          {loading ? '加载中…' : `${entries.length} 个已注册组件`}
        </span>
      </div>

      {loading ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-6 text-center text-[11px] ink-border ink-text-faint">
          <p>组件清单加载中…</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-6 text-center text-[11px] ink-border ink-text-faint">
          <PackageOpen size={24} strokeWidth={1.5} className="mx-auto mb-2 ink-text-faint" aria-hidden />
          <p>暂无已挂载组件</p>
          <p className="mt-1 text-[10px]">组件由补丁链登记（agent 自写 / 外部 URL 拉取注册），挂载即在此可见</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {entries.map((entry) => (
            <li key={entry.name} className="flex items-start gap-3" data-component={entry.name}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[var(--ink-font-xs)] font-medium">{entry.name}</span>
                  <span className="ink-chip font-mono text-[9px] ink-text-faint">{entry.version}</span>
                  {entry.renderer_key ? (
                    <span className="ink-chip font-mono text-[9px] ink-text-faint" data-ui={`component_renderer_${entry.name}`}>
                      {entry.renderer_key}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[9px] ink-text-faint break-all">{entry.url}</span>
                {entry.hash ? (
                  <span className="mt-0.5 block truncate font-mono text-[9px] ink-text-faint">{entry.hash.slice(0, 24)}…</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
