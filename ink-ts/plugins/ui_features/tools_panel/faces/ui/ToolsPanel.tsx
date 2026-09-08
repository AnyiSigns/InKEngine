// gate: 超限(464 行) - 工具设置单节（tools.full 全量视图 + 权限矩阵同文件防漂移）
/**
 * agent 工具管理面板（设置页「工具」tab）：全量工具视图 + 常驻必带 + 权限矩阵。
 *
 * 数据源（W1 收敛）：tools.full（uses_vectors + 每行消费旗标 baseline/
 * approved/enabled，engine 运行态单源）+ capability.*（auto 审批清单/档位
 * 登记/回合上限）。
 * - 常驻必带勾选 → capability.baseline.set（白名单校验失败给 notice）；
 * - 档位分段（allow/review）→ capability.tier.set（security_tier_overrides_set
 *   映射；deny 为出厂档，不提供覆盖面）；
 * - 自动审批勾选 → capability.put（auto_approve_tools / auto_approve_all_review）。
 */

import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Search, Shield, Wrench } from 'lucide-react';

import type { AppBackend } from '@app/backend';
import type { ToolFullRow } from '@/shared/backend/backendAdapter';
import { resolveToolLabel } from '@/shared/labels/toolLabels';
import { logger } from '@/shared/logger';
import { useT } from '@/i18n/useT';

const TIER_OPTIONS = ['allow', 'review'] as const;
type PermissionTier = (typeof TIER_OPTIONS)[number];

/** 动态注册机制工具：语义检索入口，强制常驻不可摘除。 */
const IMMUTABLE_TOOLS = new Set(['search_tools', 'request_tool']);

interface ToolsPanelProps {
  backend: AppBackend;
}

export function ToolsPanel({ backend }: ToolsPanelProps) {
  const { t } = useT();
  const [view, setView] = useState<{ uses_vectors: boolean; tools: ToolFullRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [detailToolName, setDetailToolName] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoApproveTools, setAutoApproveTools] = useState<string[]>([]);
  const [autoApproveAllReview, setAutoApproveAllReview] = useState(false);
  const [tierOverrides, setTierOverrides] = useState<Record<string, string>>({});
  const [maxToolRounds, setMaxToolRounds] = useState<number>(12);
  const [roundsSaving, setRoundsSaving] = useState(false);
  const [permSaving, setPermSaving] = useState(false);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const [full, capability, baseline] = await Promise.all([
        backend.getToolsManifest(),
        backend.getCapability().catch(() => ({ autoApproveTools: [], autoApproveAllReview: false, tierOverrides: {}, maxToolRounds: undefined })),
        backend.getToolBaseline().catch(() => [] as string[]),
      ]);
      const baselineSet = new Set(baseline);
      setView({
        uses_vectors: full.uses_vectors,
        tools: full.tools.map((row) => ({ ...row, baseline: baselineSet.size > 0 ? baselineSet.has(row.name) : row.baseline })),
      });
      setAutoApproveTools(capability.autoApproveTools);
      setAutoApproveAllReview(capability.autoApproveAllReview);
      setTierOverrides(capability.tierOverrides);
      if (capability.maxToolRounds !== undefined) {
        setMaxToolRounds(capability.maxToolRounds);
      }
    } catch (err) {
      logger.error('tools', '工具清单装载失败', { err: String(err) });
      setLoadError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [backend]);

  const tools = view?.tools ?? [];

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
      setView((prev) => prev ? { ...prev, tools: prev.tools.map((row) => ({ ...row, baseline: applied.has(row.name) })) } : prev);
    }
    setSaving(false);
  };

  const setTier = async (name: string, tier: PermissionTier): Promise<void> => {
    setPermSaving(true);
    setNotice(null);
    const next = { ...tierOverrides, [name]: tier };
    const result = await backend.setTierOverrides(next);
    if (!result.ok) {
      setNotice(`档位设置被拒：${result.error ?? '未知错误'}`);
    } else {
      setTierOverrides(next);
    }
    setPermSaving(false);
  };

  const toggleAutoApprove = async (name: string, checked: boolean): Promise<void> => {
    setPermSaving(true);
    setNotice(null);
    const next = checked ? [...autoApproveTools, name] : autoApproveTools.filter((n) => n !== name);
    const result = await backend.setAutoApprove(next, autoApproveAllReview);
    if (!result.ok) {
      setNotice(`自动审批设置失败：${result.error ?? '未知错误'}`);
    } else {
      setAutoApproveTools(next);
    }
    setPermSaving(false);
  };

  const toggleAllReview = async (checked: boolean): Promise<void> => {
    setPermSaving(true);
    setNotice(null);
    const result = await backend.setAutoApprove(autoApproveTools, checked);
    if (!result.ok) {
      setNotice(`自动审批设置失败：${result.error ?? '未知错误'}`);
    } else {
      setAutoApproveAllReview(checked);
    }
    setPermSaving(false);
  };

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
      setNotice(`回合工具上限设置失败：${result.error ?? '未知错误'}`);
    } else {
      setMaxToolRounds(value);
    }
    setRoundsSaving(false);
  };

  const effectiveTierOf = (name: string): PermissionTier =>
    tierOverrides[name] === 'allow' || tierOverrides[name] === 'review' ? tierOverrides[name] : 'review';

  const detailRow = detailToolName ? tools.find((row) => row.name === detailToolName) ?? null : null;

  return (
    <section className="ink-panel p-4" data-ui="tools_panel">
      <div className="mb-1 flex items-center gap-2.5">
        <Wrench size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">{t('tools.title')}</span>
        <span className="ml-auto text-[10px] ink-text-faint">
          {view ? `tools.full · ${tools.length} 个工具 · 常驻必带 ${pinnedTools.length}` : '加载中…'}
        </span>
      </div>
      <p className="mb-3 text-[10px] leading-relaxed ink-text-faint">
        {view
          ? `工具视图 ${view.uses_vectors ? '向量态可用' : '向量态降级（uses_vectors=false）'} —— 常驻必带每回合注入，其余经语义检索动态注册`
          : t('tools.intro')}
      </p>

      <div className="mb-3 rounded-lg border border-[var(--ink-border)] px-3 py-2.5" data-ui="tools_permission_matrix">
        <div className="flex items-center gap-2">
          <Shield size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          <span className="text-[10px] font-medium tracking-wide">{t('tools.permission_matrix')}</span>
          <span className="text-[9px] ink-text-faint">{t('tools.permission_matrix_hint')}</span>
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
          {autoApproveTools.length === 0 ? (
            <span className="text-[9px] ink-text-faint">{t('tools.no_auto_approvable')}</span>
          ) : (
            [...autoApproveTools].sort().map((name) => (
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
      </div>

      {loading ? (
        <div className="py-6 text-center text-[11px] ink-text-faint">{t('tools.loading')}</div>
      ) : loadError ? (
        <div className="py-4 text-center text-[11px] ink-accent">
          工具清单读取失败
          <button type="button" className="ink-link ml-2 text-[11px]" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : tools.length === 0 ? (
        <div className="py-6 text-center text-[11px] ink-text-faint">{t('tools.empty')}</div>
      ) : (
        <div className="space-y-4">
          <section data-ui="tools_group_baseline">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="ink-chip py-px text-[9px]">{t('tools.baseline')}</span>
              <span className="text-[10px] ink-text-faint">
                {t('tools.baseline_desc')}（{pinnedTools.length}）
              </span>
            </div>
            <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
              {pinnedTools.length === 0 ? (
                <div className="px-3 py-3 text-[10px] ink-text-faint">常驻必带为空</div>
              ) : (
                pinnedTools.map((row) => (
                  <ToolRow
                    key={row.name}
                    row={row}
                    autoApproved={autoApproveTools.includes(row.name)}
                    effectiveTier={effectiveTierOf(row.name)}
                    permSaving={permSaving}
                    saving={saving}
                    t={t}
                    onOpenDetail={() => setDetailToolName(row.name)}
                    onSetTier={(tier) => void setTier(row.name, tier)}
                    onToggleAutoApprove={(checked) => void toggleAutoApprove(row.name, checked)}
                    action={
                      IMMUTABLE_TOOLS.has(row.name) ? (
                        <span className="shrink-0 text-[9px] ink-text-faint">{t('tools.mechanism_pinned')}</span>
                      ) : (
                        <button
                          type="button"
                          data-ui={`baseline_remove_${row.name}`}
                          disabled={saving}
                          onClick={() => void togglePin(row.name, false)}
                          className="shrink-0 rounded-md border border-[var(--ink-border)] px-2 py-1 text-[9px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent disabled:opacity-50"
                        >
                          {t('tools.remove_baseline')}
                        </button>
                      )
                    }
                  />
                ))
              )}
            </div>
          </section>

          <section data-ui="tools_group_dynamic">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="ink-chip py-px text-[9px]">{t('tools.dynamic')}</span>
              <span className="text-[10px] ink-text-faint">{t('tools.dynamic_desc')}</span>
            </div>
            {dynamicTools.length === 0 ? (
              <div className="rounded-xl border border-dashed px-3 py-5 text-center text-[10px] ink-border ink-text-faint">
                {t('tools.all_pinned_or_empty')}
              </div>
            ) : (
              <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
                {dynamicTools.map((row) => (
                  <ToolRow
                    key={row.name}
                    row={row}
                    autoApproved={autoApproveTools.includes(row.name)}
                    effectiveTier={effectiveTierOf(row.name)}
                    permSaving={permSaving}
                    saving={saving}
                    t={t}
                    onOpenDetail={() => setDetailToolName(row.name)}
                    onSetTier={(tier) => void setTier(row.name, tier)}
                    onToggleAutoApprove={(checked) => void toggleAutoApprove(row.name, checked)}
                    action={
                      <button
                        type="button"
                        data-ui={`baseline_add_${row.name}`}
                        disabled={saving}
                        onClick={() => void togglePin(row.name, true)}
                        className="shrink-0 rounded-md bg-[var(--ink-accent)] px-2 py-1 text-[9px] font-medium text-[var(--ink-text-base)] hover:opacity-90 cursor-pointer disabled:opacity-50"
                      >
                        {t('tools.add_baseline')}
                      </button>
                    }
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {detailRow && (
        <div className="fixed inset-0 z-[var(--ink-z-floater)] flex items-center justify-center bg-black/40" data-ui="tool_detail_overlay">
          <div className="w-[480px] max-w-[calc(100vw-32px)] rounded-lg border bg-[var(--ink-bg-surface)] p-4 shadow-[var(--ink-shadow-pop)]">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[13px] font-medium font-mono">{detailRow.name}</h3>
              <button
                type="button"
                data-ui="tool_detail_close"
                onClick={() => setDetailToolName(null)}
                className="text-[10px] ink-text-faint hover:text-[var(--ink-text-base)] cursor-pointer"
              >
                {t('tools.close')}
              </button>
            </div>
            <div className="flex flex-wrap gap-2 text-[10px]">
              <span className="ink-chip py-px text-[9px]">向量 {detailRow.vector ? '可用' : '无'}</span>
              <span className="ink-chip py-px text-[9px]">注入 {detailRow.enabled ? '是' : '否'}</span>
              <span className="ink-chip py-px text-[9px]">常驻必带 {detailRow.baseline ? '是' : '否'}</span>
              <span className="ink-chip py-px text-[9px]">自动审批 {detailRow.approved ? '是' : '否'}</span>
            </div>
            <p className="mt-3 text-[10px] ink-text-muted">{resolveToolLabel({ tool: detailRow.name })}</p>
          </div>
        </div>
      )}
    </section>
  );
}

interface ToolRowProps {
  row: ToolFullRow;
  autoApproved: boolean;
  effectiveTier: PermissionTier;
  permSaving: boolean;
  saving: boolean;
  t: (k: string) => string;
  onOpenDetail: () => void;
  onSetTier: (tier: PermissionTier) => void;
  onToggleAutoApprove: (checked: boolean) => void;
  action?: React.ReactNode;
}

function ToolRow({
  row,
  autoApproved,
  effectiveTier,
  permSaving,
  saving,
  t,
  onOpenDetail,
  onSetTier,
  onToggleAutoApprove,
  action,
}: ToolRowProps) {
  return (
    <div className="px-3 py-2" data-tool={row.name}>
      <div className="flex items-center gap-2">
        <span className="ink-icon-chip h-5 w-5 flex-shrink-0">
          <Wrench size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 font-mono text-[11px] font-medium truncate">{row.name}</span>
        <span className="shrink-0 text-[9px] ink-text-muted">{resolveToolLabel({ tool: row.name })}</span>
        {row.vector && <span className="ink-chip py-px text-[8px] ink-text-faint" data-vector="yes">向量</span>}
        {row.enabled === false && <span className="ink-chip py-px text-[8px] ink-text-faint">未注入</span>}
        <label className="flex shrink-0 items-center gap-1 cursor-pointer text-[8px] ink-text-faint" data-ui={`auto_approve_row_${row.name}`} title={t('tools.auto_approve_row')}>
          <input
            type="checkbox"
            className="ink-check"
            checked={autoApproved}
            disabled={permSaving}
            onChange={(e) => onToggleAutoApprove(e.target.checked)}
          />
          {t('tools.auto')}
        </label>
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--ink-border)] p-0.5" data-ui={`tool_tier_${row.name}`}>
          {TIER_OPTIONS.map((tier) => {
            const active = effectiveTier === tier;
            const locked = permSaving || saving;
            return (
              <button
                key={tier}
                type="button"
                data-ui={`tool_tier_${row.name}_${tier}`}
                disabled={locked}
                onClick={() => onSetTier(tier)}
                className={`rounded px-1.5 py-0.5 text-[8px] font-mono leading-none cursor-pointer disabled:cursor-not-allowed ${
                  active ? 'bg-[var(--ink-accent-approval)]/20 text-[var(--ink-text-base)]' : 'text-[var(--ink-text-faint)] hover:text-[var(--ink-text-muted)]'
                }`}
              >
                {tier === 'allow' ? '允许' : '评审'}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          data-ui={`tool_detail_open_${row.name}`}
          onClick={onOpenDetail}
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
