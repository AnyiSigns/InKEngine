/**
 * agent 工具管理面板（设置页「工具」tab）：常驻必带工具集 + 全量工具视图
 * + 权限矩阵（逐工具 allow/review/deny 档位编辑 + 自动审批勾选）。
 *
 * 数据源：tools_manifest（引擎 merged_specs 全量工具，含 MCP 挂载）——
 * 生产/开发均为真实数据（BLOCKING-1 修复面：不再读 fixture-only 的
 * getToolDetails）。
 *
 * 语义（与引擎 BASELINE_TOOL_NAMES 同源）：
 * - 常驻必带 = 用户指定每回合必带工具（collect_specs 注入完整 schema，
 *   未来回合稳定可用，无需语义检索）；
 * - 动态可用 = 必带集之外的工具，agent 经 search_tools 检索、
 *   request_tool 绑定后动态注册使用。
 * 动态注册机制工具（search_tools/request_tool）强制常驻，不可摘除。
 *
 * 权限矩阵（安全信任节拆解后并入）：档位覆盖写引擎安全域
 * （deny 出厂档不可覆盖，须经补丁链转正）；自动审批 = 用户预授权
 * 只读感知/测试构建类工具跳过人审弹卡（deny/沙箱/审计环节不动）。
 *
 * 功能：常驻必带区（可摘除）+ 动态可用区（按 MCP server / 工具族分组，
 * 可设为常驻）+ 搜索/四层筛选 + 行为手册详情抽屉。
 */

import { useEffect, useMemo, useState } from 'react';
import { Wrench, Search, BookOpen, Shield, Server } from 'lucide-react';

import type { AppBackend } from '../../backend';
import type { ToolLayer } from '../../types';
import { TOOL_LAYER_LABELS } from '../../types';
import type { ToolManifestEntry } from '@/shared/backend/backendAdapter';
import { resolveToolLabel, permissionLabel } from '@/shared/labels/toolLabels';
import { classifyToolFamily, FAMILY_LABELS } from '@/shared/labels/toolLabels';
import { useT } from '@/i18n/useT';

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

const PERMISSION_TIERS = ['allow', 'review', 'deny'] as const;
type PermissionTier = (typeof PERMISSION_TIERS)[number];

function isPermissionTier(v: string): v is PermissionTier {
  return (PERMISSION_TIERS as readonly string[]).includes(v);
}

/** 动态注册机制工具：语义检索入口，强制常驻不可摘除。 */
const IMMUTABLE_TOOLS = new Set(['search_tools', 'request_tool']);

/** 出厂随包 MCP server（manifest contracts：exec_mcp_id/host_id），非市场挂载。 */
const BUILTIN_MCP_SERVERS = new Set(['inkling_exec', 'inkling_shell']);

/** 工具层分类判定（与 seed_data/tools.json meta.domain 同源）。 */
function classifyToolLayer(tool: ToolManifestEntry): ToolLayer {
  const family = classifyToolFamily(tool.name);
  const domain = tool.meta?.domain;
  if (domain === 'self' || family === 'self') return 'self_referential';
  if (domain === 'os' || /inspect_/.test(tool.name)) return 'introspective';
  if (domain === 'research' || family === 'research') return 'declarative';
  if (tool.meta?.sensor !== undefined || tool.meta?.control !== undefined) return 'introspective';
  return family === 'mcp' ? 'introspective' : 'dynamic';
}

/** MCP 工具归属 server id（meta.mcp_server 或 endpoint_config.server_id）。 */
function mcpServerIdOf(tool: ToolManifestEntry): string | undefined {
  if (tool.meta?.mcp_server) return tool.meta.mcp_server;
  const serverId = tool.endpoint_config?.server_id;
  return typeof serverId === 'string' && serverId ? serverId : undefined;
}

function ToolTierBadge({ tier }: { tier?: string }) {
  if (!tier) return null;
  const label = tier === 'main' ? 'main' : tier === 'router' ? 'router' : tier;
  return (
    <span className="ink-chip py-px text-[8px] font-mono ink-text-faint" data-tier={tier}>
      {label}
    </span>
  );
}

function AutoApprovableBadge({ autoApprovable, t }: { autoApprovable?: boolean; t: (k: string) => string }) {
  if (!autoApprovable) return null;
  return (
    <span className="ink-chip py-px text-[8px] ink-text-faint" data-auto-approvable>
      {t('tools.auto_approve')}
    </span>
  );
}

function SourceBadge({ source, serverName, t }: { source?: string; serverName?: string; t: (k: string) => string }) {
  if (serverName) {
    return (
      <span className="flex items-center gap-0.5 ink-chip py-px text-[8px] ink-text-faint" data-mcp-server>
        <Server size={8} strokeWidth={1.6} aria-hidden />
        {serverName}
      </span>
    );
  }
  if (source === 'introspection') {
    return <span className="ink-chip py-px text-[8px] ink-text-faint">{t('tools.introspective')}</span>;
  }
  if (source === 'self') {
    return <span className="ink-chip py-px text-[8px] ink-text-faint">{t('tools.self_referential')}</span>;
  }
  return null;
}

/** 逐工具档位分段（allow/review/deny；deny 出厂档锁定不可覆盖）。 */
function PermissionTierSegment({
  tool,
  effective,
  factory,
  disabled,
  saving,
  t,
  onChange,
}: {
  tool: string;
  effective: PermissionTier;
  factory: PermissionTier;
  disabled?: boolean;
  saving?: boolean;
  t: (k: string) => string;
  onChange: (tier: PermissionTier) => void;
}) {
  const denyLocked = factory === 'deny';
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--ink-border)] p-0.5" data-ui={`tool_tier_${tool}`}>
      {PERMISSION_TIERS.map((tier) => {
        const active = effective === tier;
        const locked = denyLocked || (disabled ?? false) || (saving ?? false);
        return (
          <button
            key={tier}
            type="button"
            data-ui={`tool_tier_${tool}_${tier}`}
            disabled={locked}
            title={
              denyLocked && tier !== 'deny'
                ? t('tools.deny_locked_tooltip')
                : interpolate(t('tools.tier_tooltip'), { t: permissionLabel(tier) })
            }
            onClick={() => onChange(tier)}
            className={`rounded px-1.5 py-0.5 text-[8px] font-mono leading-none cursor-pointer disabled:cursor-not-allowed ${
              active ? 'bg-[var(--ink-accent-approval)]/20 text-[var(--ink-text-base)]' : 'text-[var(--ink-text-faint)] hover:text-[var(--ink-text-muted)]'
            }`}
          >
            {permissionLabel(tier)}
          </button>
        );
      })}
    </div>
  );
}

interface ToolDetailDrawerProps {
  tool: ToolManifestEntry;
  t: (k: string) => string;
  onClose: () => void;
}

function ToolDetailDrawer({ tool, t, onClose }: ToolDetailDrawerProps) {
  const props = (tool.parameters as Record<string, unknown> | undefined) ?? {};
  const paramKeys = Object.keys(props);

  return (
    <div className="fixed inset-0 z-[var(--ink-z-floater)] flex items-center justify-center bg-black/40" data-ui="tool_detail_overlay">
      <div className="w-[640px] max-w-[calc(100vw-32px)] rounded-lg border bg-[var(--ink-bg-surface)] p-4 shadow-[var(--ink-shadow-pop)]">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-medium font-mono">{tool.name}</h3>
          <button
            type="button"
            data-ui="tool_detail_close"
            onClick={onClose}
            className="text-[10px] ink-text-faint hover:text-[var(--ink-text-base)] cursor-pointer"
          >
            {t('tools.close')}
          </button>
        </div>
        <div className="space-y-3 text-[11px]">
          <div>
            <span className="block text-[10px] ink-text-muted">{t('tools.playbook')}</span>
            <div className="mt-1 text-[9px] leading-relaxed whitespace-pre-wrap ink-text-muted">
              {tool.description || t('tools.no_description')}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="flex items-center gap-1 font-mono text-[9px]">
              <Shield size={10} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
              {interpolate(t('tools.permission_tier'), { t: permissionLabel(tool.approval ?? 'allow') })}
            </span>
            <span className="flex items-center gap-1 font-mono text-[9px]">
              {interpolate(t('tools.endpoint'), { t: tool.endpoint ?? '—' })}
            </span>
            {tool.meta?.tier ? <ToolTierBadge tier={tool.meta.tier} /> : null}
            {tool.meta?.auto_approvable ? <AutoApprovableBadge autoApprovable={tool.meta.auto_approvable} t={t} /> : null}
          </div>
          {paramKeys.length > 0 ? (
            <div>
              <span className="block text-[10px] ink-text-muted mb-1">{t('tools.param_schema')}</span>
              <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
                {paramKeys.map((key) => {
                  const def = props[key] as Record<string, unknown> | undefined;
                  const required = Array.isArray(def?.required) && def.required.includes(key);
                  return (
                    <div key={key} className="px-2.5 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[9px]">{key}</span>
                        {required ? <span className="ink-chip py-px text-[7px] ink-text-faint">{t('tools.required')}</span> : null}
                        <span className="text-[9px] ink-text-faint">{(def?.type as string) ?? 'unknown'}</span>
                      </div>
                      {typeof def?.description === 'string' && def.description ? (
                        <span className="block mt-0.5 text-[8px] leading-relaxed ink-text-faint">{def.description}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface ToolsPanelProps {
  backend: AppBackend;
}

export function ToolsPanel({ backend }: ToolsPanelProps) {
  const { t } = useT();
  const [manifest, setManifest] = useState<{ tools: ToolManifestEntry[]; baseline: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serverNames, setServerNames] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLayer, setSelectedLayer] = useState<ToolLayer | 'all'>('all');
  const [detailToolName, setDetailToolName] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoApprovable, setAutoApprovable] = useState<Set<string>>(new Set());
  const [autoApproveTools, setAutoApproveTools] = useState<string[]>([]);
  const [autoApproveAllReview, setAutoApproveAllReview] = useState(false);
  const [tierOverrides, setTierOverrides] = useState<Record<string, string>>({});
  const [maxToolRounds, setMaxToolRounds] = useState<number>(12);
  const [roundsSaving, setRoundsSaving] = useState(false);
  const [permSaving, setPermSaving] = useState(false);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [next, status, capability, snapshot] = await Promise.all([
        backend.getToolsManifest(),
        backend.getMcpMarketStatus().catch(() => ({ markets: [], mounted: {} })),
        backend.getCapability().catch(() => ({ autoApproveTools: [], autoApproveAllReview: false, tierOverrides: {}, maxToolRounds: undefined })),
        backend.getToolsSnapshot().catch(() => []),
      ]);
      const names: Record<string, string> = {};
      for (const market of status.markets) {
        for (const server of market.servers) names[server.id] = server.name;
      }
      setManifest(next);
      setServerNames(names);
      setAutoApprovable(new Set(snapshot.filter((t) => t.auto_approvable).map((t) => t.tool)));
      setAutoApproveTools(capability.autoApproveTools);
      setAutoApproveAllReview(capability.autoApproveAllReview);
      setTierOverrides(capability.tierOverrides);
      if (capability.maxToolRounds !== undefined) {
        setMaxToolRounds(capability.maxToolRounds);
      }
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [backend]);

  const baseline = useMemo(() => new Set(manifest?.baseline ?? []), [manifest]);
  const tools = manifest?.tools ?? [];

  const pinnedTools = useMemo(() => tools.filter((t) => baseline.has(t.name)), [tools, baseline]);
  const pinnedStale = useMemo(
    () => [...baseline].filter((name) => !tools.some((t) => t.name === name)),
    [baseline, tools],
  );

  const { dynamicGroups } = useMemo(() => {
    let filtered = tools.filter((t) => !baseline.has(t.name));
    if (selectedLayer !== 'all') {
      filtered = filtered.filter((tool) => classifyToolLayer(tool) === selectedLayer);
    }
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (tool) =>
          tool.name.toLowerCase().includes(q) ||
          resolveToolLabel({ tool: tool.name }).toLowerCase().includes(q),
      );
    }

    const groups = new Map<string, ToolManifestEntry[]>();
    for (const tool of filtered) {
      const serverId = mcpServerIdOf(tool);
      if (serverId) {
        const label = BUILTIN_MCP_SERVERS.has(serverId)
          ? `内置 · ${serverId}`
          : `MCP · ${serverNames[serverId] ?? serverId}`;
        const bucket = groups.get(label);
        if (bucket) bucket.push(tool);
        else groups.set(label, [tool]);
        continue;
      }
      const family = classifyToolFamily(tool.name);
      const label = FAMILY_LABELS[family] ?? family;
      const bucket = groups.get(label);
      if (bucket) bucket.push(tool);
      else groups.set(label, [tool]);
    }
    return { dynamicGroups: Array.from(groups.entries()) };
  }, [tools, baseline, selectedLayer, searchQuery, serverNames]);

    const layerOptions: Array<{ value: ToolLayer | 'all'; label: string }> = [
      { value: 'all', label: t('tools.layer_all') },
      { value: 'declarative', label: TOOL_LAYER_LABELS.declarative },
      { value: 'self_referential', label: TOOL_LAYER_LABELS.self_referential },
      { value: 'introspective', label: TOOL_LAYER_LABELS.introspective },
      { value: 'dynamic', label: TOOL_LAYER_LABELS.dynamic },
    ];

  const togglePin = async (name: string, pin: boolean): Promise<void> => {
    setSaving(true);
    setNotice(null);
    const next = new Set(baseline);
    if (pin) next.add(name);
    else next.delete(name);
    try {
    const result = await backend.setToolBaseline([...next]);
      if (!result.ok) {
        setNotice(interpolate(t('tools.setting_failed'), { e: result.error ?? '未知错误' }));
        return;
      }
      const nextBaseline = new Set(result.tools ?? []);
      setManifest((prev) =>
        prev
          ? {
              tools: prev.tools.map((t) => ({ ...t, baseline: nextBaseline.has(t.name) })),
              baseline: [...nextBaseline],
            }
          : prev,
      );
    } catch (err) {
      setNotice(interpolate(t('tools.setting_failed'), { e: String(err) }));
    } finally {
      setSaving(false);
    }
  };

  /** 档位覆盖写入（等于出厂档 = 撤销覆盖回出厂）。 */
  const setTier = async (tool: string, tier: PermissionTier): Promise<void> => {
    const factory = (manifest?.tools.find((t) => t.name === tool)?.approval ?? 'allow') as PermissionTier;
    setPermSaving(true);
    setNotice(null);
    const next = { ...tierOverrides };
    if (tier === factory) delete next[tool];
    else next[tool] = tier;
    const result = await backend.setTierOverrides(next);
    if (!result.ok) {
      setNotice(interpolate(t('tools.tier_set_failed'), { e: result.error ?? '未知错误' }));
    } else {
      setTierOverrides(next);
    }
    setPermSaving(false);
  };

  /** 自动审批勾选（只读感知/测试构建类工具；边界外安全域硬拒）。 */
  const toggleAutoApprove = async (tool: string, checked: boolean): Promise<void> => {
    setPermSaving(true);
    setNotice(null);
    const next = checked ? [...autoApproveTools, tool] : autoApproveTools.filter((t) => t !== tool);
    const result = await backend.setAutoApprove(next, autoApproveAllReview);
    if (!result.ok) {
      setNotice(interpolate(t('tools.auto_approve_set_failed'), { e: result.error ?? '未知错误' }));
    } else {
      setAutoApproveTools(next);
    }
    setPermSaving(false);
  };

  /** 自动审批全量开关（全 review 档直过）。 */
  const toggleAllReview = async (checked: boolean): Promise<void> => {
    setPermSaving(true);
    setNotice(null);
    const result = await backend.setAutoApprove(autoApproveTools, checked);
    if (!result.ok) {
      setNotice(interpolate(t('tools.auto_approve_set_failed'), { e: result.error ?? '未知错误' }));
    } else {
      setAutoApproveAllReview(checked);
    }
    setPermSaving(false);
  };

  /** 回合工具上限保存（正整数 1..200；保存后引擎重建即时生效）。 */
  const saveMaxToolRounds = async (raw: string): Promise<void> => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 200) {
      setNotice(t('tools.rounds_invalid'));
      return;
    }
    setRoundsSaving(true);
    setNotice(null);
    const result = await backend.setMaxToolRounds(value);
    if (!result.ok) {
      setNotice(interpolate(t('tools.rounds_set_failed'), { e: result.error ?? '未知错误' }));
    } else {
      setMaxToolRounds(value);
      setNotice(t('tools.rounds_saved'));
    }
    setRoundsSaving(false);
  };

  const effectiveTierOf = (tool: ToolManifestEntry): PermissionTier => {
    const value = tierOverrides[tool.name] ?? tool.approval ?? 'allow';
    return isPermissionTier(value) ? value : 'allow';
  };

  const factoryTierOf = (tool: ToolManifestEntry): PermissionTier =>
    isPermissionTier(tool.approval ?? 'allow') ? (tool.approval as PermissionTier) : 'allow';

  return (
    <section className="ink-panel p-4" data-ui="tools_panel">
      <div className="mb-1 flex items-center gap-2.5">
        <Wrench size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">{t('tools.title')}</span>
        <span className="ml-auto text-[10px] ink-text-faint">
          {manifest ? interpolate(t('tools.count_summary'), { total: tools.length, baseline: baseline.size }) : '加载中…'}
        </span>
      </div>
      <p className="mb-3 text-[10px] leading-relaxed ink-text-faint">
        {t('tools.intro')}
      </p>

      <div className="mb-3 rounded-lg border border-[var(--ink-border)] px-3 py-2.5" data-ui="tools_permission_matrix">
        <div className="flex items-center gap-2">
          <Shield size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          <span className="text-[10px] font-medium tracking-wide">{t('tools.permission_matrix')}</span>
          <span className="text-[9px] ink-text-faint">
            {t('tools.permission_matrix_hint')}
          </span>
          <label className="ml-auto flex items-center gap-1.5 cursor-pointer text-[9px] ink-text-muted" data-ui="auto_approve_all">
            <input
              type="checkbox"
              className="ink-check"
              checked={autoApproveAllReview}
              disabled={permSaving}
              onChange={(e) => void toggleAllReview(e.target.checked)}
            />
            {t('tools.auto_approve_all')}
          </label>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="text-[9px] ink-text-faint">{t('tools.auto_approve_hint')}</span>
          {autoApprovable.size === 0 ? (
            <span className="text-[9px] ink-text-faint">{t('tools.no_auto_approvable')}</span>
          ) : (
            [...autoApprovable].sort().map((name) => (
              <label key={name} className="flex items-center gap-1 cursor-pointer font-mono text-[9px] ink-text-muted" data-ui={`auto_approve_${name}`}>
                <input
                  type="checkbox"
                  className="ink-check"
                  checked={autoApproveTools.includes(name)}
                  disabled={permSaving}
                  onChange={(e) => void toggleAutoApprove(name, e.target.checked)}
                />
                {name}
              </label>
            ))
          )}
        </div>
      </div>

      <div className="mb-3 rounded-lg border border-[var(--ink-border)] px-3 py-2.5" data-ui="tools_rounds">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium tracking-wide">{t('tools.rounds_title')}</span>
          <span className="text-[9px] ink-text-faint">{t('tools.rounds_hint')}</span>
          <label className="ml-auto flex items-center gap-1.5 text-[9px] ink-text-muted">
            <input
              type="number"
              min={1}
              max={200}
              className="ink-input w-20 text-[11px]"
              value={maxToolRounds}
              disabled={roundsSaving}
              onChange={(e) => setMaxToolRounds(Number(e.target.value))}
              onBlur={(e) => void saveMaxToolRounds(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveMaxToolRounds((e.target as HTMLInputElement).value);
              }}
              data-ui="max_tool_rounds"
            />
          </label>
        </div>
      </div>

      {notice ? (
        <p className="mb-2 rounded-lg px-3 py-2 text-[11px] ink-feedback-fail" data-ui="tools_notice">
          {notice}
        </p>
      ) : null}

      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder={t('tools.search_placeholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ink-input w-full pl-7 text-[11px]"
            data-ui="tools_search"
          />
          <Search size={12} strokeWidth={1.5} className="absolute left-2 top-1/2 -translate-y-1/2 ink-text-faint" aria-hidden />
        </div>
        <select
          value={selectedLayer}
          onChange={(e) => setSelectedLayer(e.target.value as ToolLayer | 'all')}
          className="ink-input text-[11px]"
          data-ui="tools_layer_filter"
        >
          {layerOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="py-6 text-center text-[11px] ink-text-faint">{t('tools.loading')}</div>
      ) : error ? (
        <div className="py-4 text-center text-[11px] ink-accent">{interpolate(t('tools.load_failed'), { e: error })}</div>
      ) : tools.length === 0 && pinnedStale.length === 0 ? (
        <div className="py-6 text-center text-[11px] ink-text-faint">{t('tools.empty')}</div>
      ) : (
        <div className="space-y-4">
          <section data-ui="tools_group_baseline">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="ink-chip py-px text-[9px]">{t('tools.baseline')}</span>
              <span className="text-[10px] ink-text-faint">
                {interpolate(t('tools.baseline_desc'), { n: baseline.size })}
              </span>
            </div>
            <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
              {pinnedTools.map((tool) => (
                <ToolRow
                  key={tool.name}
                  tool={tool}
                  serverName={serverNames[mcpServerIdOf(tool) ?? '']}
                  onOpenDetail={setDetailToolName}
                  effectiveTier={effectiveTierOf(tool)}
                  factoryTier={factoryTierOf(tool)}
                  autoApprovableTool={autoApprovable.has(tool.name)}
                  autoApproved={autoApproveTools.includes(tool.name)}
                  permSaving={permSaving}
                  t={t}
                  onSetTier={setTier}
                  onToggleAutoApprove={toggleAutoApprove}
                  action={
                    IMMUTABLE_TOOLS.has(tool.name) ? (
                      <span className="shrink-0 text-[9px] ink-text-faint" title={t('tools.baseline_desc')}>{t('tools.mechanism_pinned')}</span>
                    ) : (
                      <button
                        type="button"
                        data-ui={`baseline_remove_${tool.name}`}
                        disabled={saving}
                        onClick={() => void togglePin(tool.name, false)}
                        className="shrink-0 rounded-md border border-[var(--ink-border)] px-2 py-1 text-[9px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent disabled:opacity-50"
                      >
                        {t('tools.remove_baseline')}
                      </button>
                    )
                  }
                />
              ))}
              {pinnedStale.map((name) => (
                <div key={name} className="px-3 py-2" data-tool={name}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 font-mono text-[11px] font-medium truncate">{name}</span>
                    <span className="ink-chip py-px text-[8px] ink-text-faint">{t('tools.stale_baseline')}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section data-ui="tools_group_dynamic">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="ink-chip py-px text-[9px]">{t('tools.dynamic')}</span>
              <span className="text-[10px] ink-text-faint">
                {t('tools.dynamic_desc')}
              </span>
            </div>
            {dynamicGroups.length === 0 ? (
              <div className="rounded-xl border border-dashed px-3 py-5 text-center text-[10px] ink-border ink-text-faint">
                {t('tools.all_pinned_or_empty')}
              </div>
            ) : (
              dynamicGroups.map(([label, groupTools]) => (
                <div key={label} className="mb-3" data-ui={`tools_group_${label}`}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="ink-chip py-px text-[9px]">{label}</span>
                    <span className="text-[10px] ink-text-faint">{interpolate(t('tools.group_tool_count'), { n: groupTools.length })}</span>
                  </div>
                  <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
                    {groupTools.map((tool) => (
                      <ToolRow
                        key={tool.name}
                        tool={tool}
                        serverName={serverNames[mcpServerIdOf(tool) ?? '']}
                        onOpenDetail={setDetailToolName}
                        effectiveTier={effectiveTierOf(tool)}
                        factoryTier={factoryTierOf(tool)}
                        autoApprovableTool={autoApprovable.has(tool.name)}
                        autoApproved={autoApproveTools.includes(tool.name)}
                        permSaving={permSaving}
                        t={t}
                        onSetTier={setTier}
                        onToggleAutoApprove={toggleAutoApprove}
                        action={
                          <button
                            type="button"
                            data-ui={`baseline_add_${tool.name}`}
                            disabled={saving}
                            onClick={() => void togglePin(tool.name, true)}
                            className="shrink-0 rounded-md bg-[var(--ink-accent)] px-2 py-1 text-[9px] font-medium text-[var(--ink-text-base)] hover:opacity-90 cursor-pointer disabled:opacity-50"
                          >
                            {t('tools.add_baseline')}
                          </button>
                        }
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}

      {detailToolName
        ? (() => {
            const found = tools.find((t) => t.name === detailToolName) ?? tools[0];
            if (!found) return null;
            return <ToolDetailDrawer tool={found} t={t} onClose={() => setDetailToolName(null)} />;
          })()
        : null}
    </section>
  );
}

interface ToolRowProps {
  tool: ToolManifestEntry;
  serverName?: string;
  onOpenDetail: (name: string) => void;
  effectiveTier: PermissionTier;
  factoryTier: PermissionTier;
  autoApprovableTool: boolean;
  autoApproved: boolean;
  permSaving: boolean;
  t: (k: string) => string;
  onSetTier: (name: string, tier: PermissionTier) => void;
  onToggleAutoApprove: (name: string, checked: boolean) => void;
  action?: React.ReactNode;
}

function ToolRow({
  tool,
  serverName,
  onOpenDetail,
  effectiveTier,
  factoryTier,
  autoApprovableTool,
  autoApproved,
  permSaving,
  t,
  onSetTier,
  onToggleAutoApprove,
  action,
}: ToolRowProps) {
  const label = resolveToolLabel({ tool: tool.name });
  const layer = classifyToolLayer(tool);
  const tier = tool.meta?.tier;
  const autoApprovable = tool.meta?.auto_approvable;

  return (
    <div className="px-3 py-2" data-tool={tool.name}>
      <div className="flex items-center gap-2">
        <span className="ink-icon-chip h-5 w-5 flex-shrink-0">
          <Wrench size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 font-mono text-[11px] font-medium truncate">{tool.name}</span>
        <span className="shrink-0 text-[9px] ink-text-muted">{label}</span>
        <SourceBadge source={tool.source} serverName={serverName} t={t} />
        <span className="shrink-0 ink-chip py-px text-[8px] ink-text-faint font-mono">{TOOL_LAYER_LABELS[layer]}</span>
        {tier ? <ToolTierBadge tier={tier} /> : null}
        {autoApprovable && autoApprovableTool ? (
          <label className="flex shrink-0 items-center gap-1 cursor-pointer text-[8px] ink-text-faint" data-ui={`auto_approve_row_${tool.name}`} title={t('tools.auto_approve_row')}>
            <input
              type="checkbox"
              className="ink-check"
              checked={autoApproved}
              disabled={permSaving}
              onChange={(e) => void onToggleAutoApprove(tool.name, e.target.checked)}
            />
            {t('tools.auto')}
          </label>
        ) : null}
        <PermissionTierSegment
          tool={tool.name}
          effective={effectiveTier}
          factory={factoryTier}
          saving={permSaving}
          t={t}
          onChange={(next) => void onSetTier(tool.name, next)}
        />
        <button
          type="button"
          data-ui={`tool_detail_open_${tool.name}`}
          onClick={() => onOpenDetail(tool.name)}
          className="shrink-0 rounded-md p-1 text-[9px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer"
          title={t('tools.view_playbook')}
        >
          <BookOpen size={9} strokeWidth={1.6} aria-hidden />
        </button>
        {action}
      </div>
    </div>
  );
}
