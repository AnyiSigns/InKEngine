// gate: 超限(360 行) - 插件设置单节（目录概览 + 工具常驻/服务启停同文件保持整链可读）
/**
 * 插件管理面板（设置页「插件」段，B4 收敛后的唯一插件管理面）。
 *
 * 语义（定稿 permission_plugin_convergence）：唯一实体 = 插件；提供物 =
 * 工具/命令/界面/服务/端点。本面板呈现 manifest 派生目录（壳侧 pluginsCatalog
 * 座位）的人类视图，行内管理动作只挂**现接线**命令面：
 * - 工具常驻必带 → capability.baseline（capability.get/set 白名单校验）；
 * - 回合工具上限 → capability.put max_tool_rounds（工具参数，迁自旧 tools_panel）；
 * - 界面组件启停 → ui_components.get/set_disabled（出厂白名单 subset）；
 * - 服务（MCP 服务端 = 工具型插件装载来源）→ mcp.status/enable/disable
 *   （B5：会话内装载 + host 台账持久化 + 重启自动拉起；启用即注册表可见、
 *   request_tool 请求即绑）；
 * - 命令/端点/非白名单界面 = 只读装配面（agent 对话受控接入随 B6）。
 * 旧 tools_panel 的权限矩阵（逐工具档位）与自动审批清单 UI 已退役（B4）。
 * 恢复默认入口在「审计与恢复」段（不重复建）。
 */

import { useEffect, useMemo, useState } from 'react';
import { Boxes, Package } from 'lucide-react';

import type { AppBackend } from '@app/backend';
import type { PluginsCatalog, PluginProvides } from '@app/pluginsCatalog';
import type { ToolFullRow, McpPluginServerView, McpPluginOutcome } from '@/shared/backend/backendAdapter';
import { resolveToolLabel } from '@/shared/labels/toolLabels';
import { useT } from '@/i18n/useT';

const IMMUTABLE_TOOLS = new Set(['search_tools', 'request_tool']);

interface PluginsPanelProps {
  backend: AppBackend;
  catalog: PluginsCatalog;
}

export function PluginsPanel({ backend, catalog }: PluginsPanelProps) {
  const { t } = useT();
  const [tools, setTools] = useState<ToolFullRow[]>([]);
  const [loadingTools, setLoadingTools] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // 服务（MCP 工具型插件）
  const [services, setServices] = useState<McpPluginServerView[] | null>(null);
  const [busyServiceId, setBusyServiceId] = useState<string | null>(null);

  // 界面组件启停
  const [uiFactory, setUiFactory] = useState<string[]>([]);
  const [uiDisabled, setUiDisabled] = useState<string[]>([]);

  const refresh = async (): Promise<void> => {
    setLoadingTools(true);
    setNotice(null);
    try {
      const [full, baseline] = await Promise.all([
        backend.getToolsManifest().catch(() => ({ uses_vectors: false, tools: [] as ToolFullRow[] })),
        backend.getToolBaseline().catch(() => [] as string[]),
      ]);
      const baselineSet = new Set(baseline);
      setTools(
        baselineSet.size > 0
          ? full.tools.map((row) => ({ ...row, baseline: baselineSet.has(row.name) }))
          : full.tools,
      );
    } finally {
      setLoadingTools(false);
    }
    const ui = await backend.getUiComponentsState().catch(() => ({ factory: [], disabled: [], active: [] }));
    setUiFactory(ui.factory);
    setUiDisabled(ui.disabled);
    setServices((await backend.getMcpPlugins().catch(() => ({ servers: [] as McpPluginServerView[] }))).servers);
  };

  useEffect(() => {
    void refresh();
  }, [backend]);

  const baselineNames = useMemo(() => new Set(tools.filter((row) => row.baseline).map((row) => row.name)), [tools]);
  const pinnedTools = useMemo(() => tools.filter((row) => row.baseline), [tools, baselineNames]);
  const dynamicTools = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return tools.filter((row) => {
      if (row.baseline) return false;
      if (q === '') return true;
      return row.name.toLowerCase().includes(q) || resolveToolLabel({ tool: row.name }).toLowerCase().includes(q);
    });
  }, [tools, searchQuery]);

  const grouped = useMemo(() => {
    const out = new Map<PluginProvides, number>();
    for (const row of catalog.rows) {
      out.set(row.provides, (out.get(row.provides) ?? 0) + 1);
    }
    return out;
  }, [catalog]);

  const togglePin = async (name: string, pin: boolean): Promise<void> => {
    setSaving(true);
    setNotice(null);
    const next = new Set(baselineNames);
    if (pin) next.add(name);
    else next.delete(name);
    const result = await backend.setToolBaseline([...next]);
    if (!result.ok) {
      setNotice(`常驻必带设置被拒：${result.error ?? '未知错误'}`);
    } else {
      const applied = new Set(result.tools ?? []);
      setTools((prev) => prev.map((row) => ({ ...row, baseline: applied.has(row.name) })));
    }
    setSaving(false);
  };

  const toggleUiComponent = async (name: string, disabled: boolean): Promise<void> => {
    setSaving(true);
    setNotice(null);
    const next = disabled
      ? [...uiDisabled.filter((n) => n !== name), name]
      : uiDisabled.filter((n) => n !== name);
    const result = await backend.setUiComponentsDisabled(next);
    if (!result.ok) {
      setNotice(`界面组件启停失败：${result.error ?? '未知错误'}`);
    } else {
      setUiDisabled(result.disabled ?? []);
    }
    setSaving(false);
  };

  const handleEnable = async (entry: McpPluginServerView): Promise<void> => {
    setBusyServiceId(entry.id);
    setNotice(null);
    const outcome: McpPluginOutcome = await backend.mcpPluginEnable(entry.id);
    if (outcome.ok === false) {
      setBusyServiceId(null);
      setNotice(outcome.error ?? '启用失败，请查看宿主日志');
      return;
    }
    await refresh();
    setBusyServiceId(null);
  };

  const handleDisable = async (entry: McpPluginServerView): Promise<void> => {
    setBusyServiceId(entry.id);
    setNotice(null);
    const outcome: McpPluginOutcome = await backend.mcpPluginDisable(entry.id);
    if (outcome.ok === false) {
      setBusyServiceId(null);
      setNotice(outcome.error ?? '停用失败，请查看宿主日志');
      return;
    }
    await refresh();
    setBusyServiceId(null);
  };

  const enabledIds = useMemo(
    () => new Set((services ?? []).filter((s) => s.enabled).map((s) => s.id)),
    [services],
  );

  const serviceRows = services ?? [];
  const componentRows = uiFactory.map((id) => ({ id, disabled: uiDisabled.includes(id) }));

  return (
    <section className="ink-panel p-4" data-ui="plugins_panel">
      <div className="mb-1 flex items-center gap-2.5">
        <Package size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">{t('plugins.title')}</span>
        <span className="ml-auto text-[10px] ink-text-faint">
          {catalog.total} 个插件 · 工具 {grouped.get('tool') ?? 0} · 界面组件 {grouped.get('ui_component') ?? 0} · 服务 {grouped.get('service') ?? 0}
        </span>
      </div>
      <p className="mb-3 text-[10px] leading-relaxed ink-text-faint">
        唯一实体 = 插件（提供物：工具 / 命令 / 界面 / 服务 / 端点）。管理动作走既有命令面：
        工具常驻必带、界面组件启停、服务（MCP 工具型插件）启停——启用即会话内装载 + 台账持久化，
        重启自动拉起。命令 / 端点 / 面板为装配只读——agent 对话受控接入随 B6 提供。
      </p>

      {notice ? (
        <p className="mb-2 rounded-lg px-3 py-2 text-[11px] ink-feedback-fail" data-ui="plugins_notice">
          {notice}
        </p>
      ) : null}

      {/* ── 工具参数：回合上限（迁自旧 tools_panel） ── */}
      <MaxRoundsField backend={backend} notice={setNotice} />

      {/* ── 常驻必带（工具） ── */}
      <div className="mb-3 flex items-center gap-2">
        <Boxes size={13} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        <span className="text-[11px] font-medium tracking-tight">常驻必带（工具）</span>
        <span className="text-[9px] ink-text-faint">每回合注入 · {pinnedTools.length}</span>
      </div>
      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
        {pinnedTools.length === 0 ? (
          <div className="px-3 py-2 text-[10px] ink-text-faint">常驻必带为空</div>
        ) : (
          pinnedTools.map((row) => (
            <ToolBaselineRow key={row.name} row={row} saving={saving} onUnpin={() => void togglePin(row.name, false)} />
          ))
        )}
      </div>

      <input
        type="text"
        placeholder={t('plugins.search_placeholder')}
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="ink-input mt-3 w-full pl-2 text-[11px]"
        data-ui="plugins_search"
      />
      {loadingTools ? (
        <div className="py-3 text-center text-[10px] ink-text-faint">加载中…</div>
      ) : dynamicTools.length === 0 ? (
        <div className="mt-1 rounded-xl border border-dashed px-3 py-3 text-center text-[10px] ink-text-faint">
          无可设常驻工具（已全部常驻或检索无匹配）
        </div>
      ) : (
        <div className="ink-elevated mt-1 divide-y divide-[var(--ink-border)] overflow-hidden rounded">
          {dynamicTools.map((row) => (
            <ToolBaselineRow key={row.name} row={row} saving={saving} onPin={() => void togglePin(row.name, true)} />
          ))}
        </div>
      )}

      {/* ── 界面组件启停 ── */}
      <div className="mt-4 mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-tight">界面组件</span>
        <span className="text-[9px] ink-text-faint">出厂白名单启停（停用 = 渲染占位拒绝）</span>
      </div>
      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
        {componentRows.length === 0 ? (
          <div className="px-3 py-2 text-[10px] ink-text-faint">无出厂界面组件</div>
        ) : (
          componentRows.map(({ id, disabled }) => (
            <div key={id} className="flex items-center gap-2 px-3 py-2" data-ui={`ui_component_${id}`}>
              <span className="min-w-0 flex-1 font-mono text-[11px] font-medium truncate">{id}</span>
              <span className="ink-chip py-px text-[9px]">{disabled ? '已停用' : '启用'}</span>
              <button
                type="button"
                data-ui={`ui_component_toggle_${id}`}
                disabled={saving}
                onClick={() => void toggleUiComponent(id, !disabled)}
                className="shrink-0 rounded-md border border-[var(--ink-border)] px-2 py-1 text-[9px] cursor-pointer disabled:opacity-50"
              >
                {disabled ? '启用' : '停用'}
              </button>
            </div>
          ))
        )}
      </div>

      {/* ── 服务（MCP 服务端 = 工具型插件装载来源） ── */}
      <div className="mt-4 mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-tight">服务</span>
        <span className="text-[9px] ink-text-faint">MCP 服务端 = 工具型插件 · 启用即装载注册、停用即回收（重启自动拉起）</span>
      </div>
      {serviceRows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-3 py-4 text-center text-[10px] ink-text-faint">
          暂无服务（plugins/mcp 无候选或宿主未装配）
        </div>
      ) : (
        <ul className="space-y-2">
          {serviceRows.map((entry) => {
            const enabled = enabledIds.has(entry.id);
            return (
              <li key={entry.id} className="flex items-start gap-3 rounded-lg border ink-border px-3 py-2" data-mcp-server={entry.id}>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-[12px] font-medium">{entry.name}</span>
                    <span className="ink-chip py-px text-[9px] ink-text-faint">{entry.transport}</span>
                    {entry.risk ? <span className="ink-chip py-px text-[9px] ink-accent">风险 {entry.risk}</span> : null}
                    {enabled ? <span className="ink-chip py-px text-[9px] ink-feedback-ok">已启用</span> : null}
                    {enabled && entry.connected ? (
                      <span className="ink-chip py-px text-[9px] ink-feedback-ok">已连接 · {entry.tool_count} 工具</span>
                    ) : enabled ? (
                      <span className="ink-chip py-px text-[9px] ink-text-faint">未连接</span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[9px] ink-text-faint">
                    {entry.command ? `${entry.command} ${entry.args.join(' ')}`.trim() : (entry.url ?? entry.source)}
                  </span>
                  {enabled && entry.error ? (
                    <span className="mt-0.5 block text-[9px] ink-feedback-fail">连接失败：{entry.error}</span>
                  ) : null}
                </span>
                <div className="flex shrink-0 gap-1">
                  {enabled ? (
                    <button
                      type="button"
                      data-ui={`service_disable_${entry.id}`}
                      onClick={() => void handleDisable(entry)}
                      disabled={busyServiceId === entry.id}
                      className="rounded-md border border-[var(--ink-border)] px-2 py-1 text-[9px] cursor-pointer disabled:opacity-50"
                    >
                      停用
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-ui={`service_enable_${entry.id}`}
                      onClick={() => void handleEnable(entry)}
                      disabled={busyServiceId === entry.id}
                      className="rounded-md bg-[var(--ink-accent)] px-2 py-1 text-[9px] font-medium cursor-pointer disabled:opacity-50"
                    >
                      启用
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── 只读：命令 / 端点 / 非白名单界面 ── */}
      <div className="mt-4 mb-1 flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-tight">装配只读</span>
        <span className="text-[9px] ink-text-faint">命令 / 端点 / 界面面板（agent 对话受控接入随 B6）</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {catalog.rows
          .filter((row) => row.provides === 'command' || row.provides === 'endpoint')
          .map((row) => (
            <span key={row.id} className="ink-chip py-px font-mono text-[8px] ink-text-faint" data-plugin={row.id}>
              {row.id}
            </span>
          ))}
      </div>

      <p className="mt-3 text-[9px] leading-relaxed ink-text-faint">
        恢复全部默认在「审计与恢复」段（含确认词兜底）；完整插件目录 = 上方统计与只读徽标清单，
        行内动作仅出现在有真实命令面的分组。
      </p>
    </section>
  );
}

interface ToolBaselineRowProps {
  row: ToolFullRow;
  saving: boolean;
  onPin?: () => void;
  onUnpin?: () => void;
}

/** 单工具行：常驻必带切换（mechanism 工具强制常驻不可摘除）。 */
function ToolBaselineRow({ row, saving, onPin, onUnpin }: ToolBaselineRowProps) {
  const isMechanism = IMMUTABLE_TOOLS.has(row.name);
  return (
    <div className="flex items-center gap-2 px-3 py-2" data-tool={row.name}>
      <span className="min-w-0 flex-1 font-mono text-[11px] font-medium truncate">{row.name}</span>
      <span className="shrink-0 text-[9px] ink-text-muted">{resolveToolLabel({ tool: row.name })}</span>
      {row.vector && <span className="ink-chip py-px text-[8px] ink-text-faint">向量</span>}
      {row.enabled === false && <span className="ink-chip py-px text-[8px] ink-text-faint">未注入</span>}
      {isMechanism ? (
        <span className="shrink-0 text-[9px] ink-text-faint">机制常驻</span>
      ) : onUnpin ? (
        <button
          type="button"
          data-ui={`baseline_remove_${row.name}`}
          disabled={saving}
          onClick={onUnpin}
          className="shrink-0 cursor-pointer rounded-md border border-[var(--ink-border)] px-2 py-1 text-[9px] disabled:opacity-50"
        >
          取消常驻
        </button>
      ) : onPin ? (
        <button
          type="button"
          data-ui={`baseline_add_${row.name}`}
          disabled={saving}
          onClick={onPin}
          className="shrink-0 cursor-pointer rounded-md bg-[var(--ink-accent)] px-2 py-1 text-[9px] font-medium disabled:opacity-50"
        >
          设为常驻
        </button>
      ) : null}
    </div>
  );
}

/** 回合工具上限（工具参数；capability.put max_tool_rounds）。 */
function MaxRoundsField({
  backend,
  notice,
}: {
  backend: AppBackend;
  notice: (msg: string | null) => void;
}) {
  const { t } = useT();
  const [value, setValue] = useState<number>(12);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void backend
      .getMaxToolRounds()
      .then((rounds) => {
        if (rounds !== undefined) setValue(rounds);
      })
      .catch(() => undefined);
  }, [backend]);

  const save = async (raw: string): Promise<void> => {
    const next = Number(raw);
    if (!Number.isInteger(next) || next < 1 || next > 200) {
      notice(t('tools.rounds_invalid'));
      return;
    }
    setSaving(true);
    const result = await backend.setMaxToolRounds(next);
    setSaving(false);
    if (!result.ok) {
      notice(`回合工具上限设置失败：${result.error ?? '未知错误'}`);
      return;
    }
    setValue(next);
  };

  return (
    <div className="mb-3 rounded-lg border border-[var(--ink-border)] px-3 py-2" data-ui="tools_rounds">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium tracking-wide">{t('tools.rounds_title')}</span>
        <span className="text-[9px] ink-text-faint">{t('tools.rounds_hint')}</span>
        <label className="ml-auto flex items-center gap-1.5 text-[9px]">
          <input
            type="number"
            min={1}
            max={200}
            className="ink-input w-20 text-[11px]"
            value={value}
            disabled={saving}
            onChange={(e) => setValue(Number(e.target.value))}
            onBlur={(e) => void save(e.target.value)}
            data-ui="max_tool_rounds"
          />
        </label>
      </div>
    </div>
  );
}
