/**
 * 组件清单视图（设置页「组件」tab）：出厂组件 + 补丁链已挂载组件 双源合并。
 *
 * 双数据源（各自独立权威，前端只读展示 + 出厂启停）：
 * - 出厂组件（factory）：种子 manifest.json contracts.renderer_components
 *   契约清单（配方 ui_allowed_components 同源），可逐项启停——停用经
 *   engine.ui_components_set_disabled 持久化，装配期过滤活跃白名单；
 * - 已挂载组件（patch_chain）：宿主 components_manifest（补丁链产物，
 *   agent 自写 / 外部 URL 组件经 ARTIFACT 补丁落链登记）。
 *
 * 挂载/注册动作在补丁链侧，本视图不承载市场浏览/挂载。
 */

import { useCallback, useEffect, useState } from 'react';
import { Boxes, PackageOpen, Power } from 'lucide-react';

import type { AppBackend } from '../../backend';
import type { AppArtifactEntry } from '../../types';

interface ComponentRegistryProps {
  backend: AppBackend;
}

export function ComponentRegistry({ backend }: ComponentRegistryProps) {
  const [entries, setEntries] = useState<AppArtifactEntry[]>([]);
  const [factory, setFactory] = useState<string[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setNotice(null);
    try {
      const [list, state] = await Promise.all([
        backend.refreshComponentManifest().then(() => backend.getComponentsManifest()),
        backend.getUiComponentsState(),
      ]);
      if (list) setEntries(list);
      setFactory(state.factory);
      setDisabled(new Set(state.disabled));
    } catch {
      // 宿主不可用 = 空清单（既有组件照常）
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleComponent = async (name: string, nextDisabled: boolean): Promise<void> => {
    setSaving(true);
    setNotice(null);
    const next = new Set(disabled);
    if (nextDisabled) next.add(name);
    else next.delete(name);
    try {
      const result = await backend.setUiComponentsDisabled([...next]);
      if (!result.ok) {
        setNotice(`出厂组件设置失败：${result.error ?? '未知错误'}`);
        return;
      }
      setDisabled(new Set(result.disabled ?? []));
      await backend.syncUiComponentGate();
    } catch (err) {
      setNotice(`出厂组件设置失败：${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="ink-panel p-4" data-ui="component_registry">
      <div className="flex items-center gap-2.5">
        <Boxes size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">组件</span>
        <span className="ml-auto text-[10px] ink-text-faint">
          {loading ? '加载中…' : `${factory.length} 出厂 · ${entries.length} 已挂载`}
        </span>
      </div>

      {notice ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-2 text-[10px] ink-border ink-text-muted" data-ui="component_notice">
          {notice}
        </div>
      ) : null}

      {/* 出厂组件：契约白名单，可逐项启停 */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="ink-chip py-px text-[9px]">出厂组件</span>
          <span className="text-[10px] ink-text-faint">
            契约白名单 · 启停经装配配方过滤（停用组件渲染占位拒绝）
          </span>
        </div>
        <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
          {factory.length === 0 ? (
            <div className="rounded-xl border border-dashed px-3 py-5 text-center text-[10px] ink-border ink-text-faint">
              <p>出厂组件清单为空</p>
            </div>
          ) : (
            factory.map((name) => {
              const isOff = disabled.has(name);
              return (
                <div
                  key={name}
                  className="flex items-center gap-2 px-3 py-2"
                  data-component={name}
                  data-disabled={isOff}
                >
                  <Power size={10} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium">{name}</span>
                  <span className="ink-chip font-mono text-[9px] ink-text-faint">factory</span>
                  <span className="ink-chip py-px text-[9px]">
                    {isOff ? '已停用' : '已启用'}
                  </span>
                  <button
                    type="button"
                    data-ui={`factory_component_${name}`}
                    data-testid={`factory_component_${name}`}
                    disabled={saving}
                    onClick={() => void toggleComponent(name, !isOff)}
                    className="shrink-0 rounded-md border border-[var(--ink-border)] px-2 py-1 text-[9px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent disabled:opacity-50"
                  >
                    {isOff ? '启用' : '停用'}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 已挂载组件：补丁链产物清单 */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="ink-chip py-px text-[9px]">已挂载组件</span>
          <span className="text-[10px] ink-text-faint">补丁链登记 · agent 自写 / 外部 URL 拉取注册</span>
        </div>
        {loading ? (
          <div className="rounded-xl border border-dashed px-3 py-6 text-center text-[11px] ink-border ink-text-faint">
            <p>组件清单加载中…</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-xl border border-dashed px-3 py-6 text-center text-[11px] ink-border ink-text-faint">
            <PackageOpen size={24} strokeWidth={1.5} className="mx-auto mb-2 ink-text-faint" aria-hidden />
            <p>暂无已挂载组件</p>
            <p className="mt-1 text-[10px]">组件由补丁链登记（agent 自写 / 外部 URL 拉取注册），挂载即在此可见</p>
          </div>
        ) : (
          <ul className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
            {entries.map((entry) => (
              <li key={entry.name} className="flex items-start gap-3 px-3 py-2" data-component={entry.name}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[var(--ink-font-xs)] font-medium">{entry.name}</span>
                    <span className="ink-chip font-mono text-[9px] ink-text-faint">{entry.version}</span>
                    <span className="ink-chip font-mono text-[9px] ink-text-faint">patch_chain</span>
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
      </div>
    </section>
  );
}
