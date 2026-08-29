/**
 * 设置「连接」节：MCP 市场管理器（列表/添加链接/删除）+ 联网搜索 key。
 *
 * MCP 市场管理：
 * - 展示用户添加的 MCP 市场（内置示例目录已移出，本页只列外部市场）；
 * - 添加链接挂载新市场 = 外部目录摄入：拉取 → vetting → 预览（名称/
 *   服务数/风险分布）→ 用户确认 → 落注册表持久化（预览即审批卡，
 *   确认即授权，与手动挂载同语义）；
 * - 删除市场 → 级联卸载其下服务；
 * - 服务级挂载/取消挂载在「市场」设置节的 MCP 市场清单（不在此重复）。
 *
 * 搜索 key 配置项（env INK_SEARCH_KEY 显式优先、设置档兜底；降级 = 用户
 * 自配 exa/parallel key/bocha），即改即存。
 * 网络白名单判定面归 OS 层沙箱（设置「工作区授权」→ OS 层），不在用户设置重复。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Plus, Search, Server, Trash2 } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Field, Select, TextInput } from '@/shared/ui/Field';
import { createBackend } from '@/shared/backend/backendAdapter';
import type {
  McpMarketPreview,
  McpMountStatus,
} from '@/shared/backend/backendAdapter';

type SearchProvider = 'exa' | 'parallel' | 'bocha';

export function ConnectSection(): JSX.Element {
  // BackendAdapter 单通道：MCP 市场管理与搜索 key 全经适配器（可 mock/可回落）。
  const backend = useMemo(() => createBackend(), []);
  const [searchKey, setSearchKey] = useState('');
  const [searchProvider, setSearchProvider] = useState<SearchProvider>('exa');
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const [status, setStatus] = useState<McpMountStatus | null>(null);
  const [marketLink, setMarketLink] = useState('');
  const [preview, setPreview] = useState<McpMarketPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!backend.available) return;
    try {
      setStatus(await backend.mcpMarketStatus());
    } catch (err) {
      setNotice(`mcp_market_status 失败：${String(err)}`);
    }
  }, [backend]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handlePreview = async (): Promise<void> => {
    const link = marketLink.trim();
    if (!link) return;
    if (!backend.available) {
      setNotice('宿主不可用（预览需真实引擎）');
      return;
    }
    setBusy(true);
    setNotice(null);
    setPreview(null);
    try {
      const result = await backend.mcpMarketPreview(link);
      setPreview(result);
      if (!result.ok) {
        setNotice(result.error ?? result.violations?.join('；') ?? '目录未通过核对');
      }
    } catch (err) {
      setNotice(`mcp_market_preview 失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = async (): Promise<void> => {
    const link = marketLink.trim();
    if (!link) return;
    if (!backend.available) {
      setNotice('宿主不可用（添加市场需真实引擎）');
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await backend.mcpMarketAdd(link);
      if (result.ok) {
        setPreview(null);
        setMarketLink('');
        setNotice(null);
        await refresh();
      } else {
        setNotice(result.error ?? '添加失败');
      }
    } catch (err) {
      setNotice(`mcp_market_add 失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (marketId: string): Promise<void> => {
    if (!backend.available) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await backend.mcpMarketRemove(marketId);
      if (result.ok) {
        await refresh();
      } else {
        setNotice(result.error ?? '删除失败');
      }
    } catch (err) {
      setNotice(`mcp_market_remove 失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSearch = async (): Promise<void> => {
    setSavePhase('saving');
    try {
      if (backend.available) {
        await backend.searchKeysPut({
          search_key: searchKey,
          search_provider: searchProvider,
        });
      }
      setSavePhase('saved');
      setTimeout(() => setSavePhase('idle'), 1200);
    } catch {
      setSavePhase('error');
      setTimeout(() => setSavePhase('idle'), 2000);
    }
  };

  const mountedCount = status ? Object.keys(status.mounted).length : 0;
  const visibleMarkets = useMemo(
    () => (status?.markets ?? []).filter((m) => !m.builtin),
    [status],
  );

  return (
    <div className="space-y-4">
      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
        <div className="flex items-center gap-3 px-3.5 py-3">
          <Server size={16} strokeWidth={1.6} className="shrink-0 ink-text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">MCP 市场</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed ink-text-faint">
                {status
                  ? `${visibleMarkets.length} 个市场 · ${visibleMarkets.reduce((n, m) => n + m.servers.length, 0)} 个服务 · 已挂载 ${mountedCount} 个`
                  : '加载中…'}
              </span>
            </span>
            <span className="shrink-0 text-[10px] ink-text-faint">服务挂载见「市场」节</span>
          </div>

        {visibleMarkets.map((market) => (
          <div key={market.id} className="flex items-center gap-3 px-3.5 py-2.5" data-mcp-market={market.id}>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[12px] font-medium">{market.name}</span>
                <span className="ink-chip py-px text-[9px] ink-text-faint">用户添加</span>
              </span>
              <span className="mt-0.5 block truncate font-mono text-[9px] ink-text-faint">
                {market.source || 'seed_data/mcp_market.json'} · {market.servers.length} 个服务
              </span>
            </span>
            <button
              type="button"
              data-ui={`mcp_market_remove_${market.id}`}
              onClick={() => void handleRemove(market.id)}
              disabled={busy}
              className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--ink-border)] px-2 py-1 text-[10px] ink-text-faint hover:text-[var(--ink-feedback-fail)] cursor-pointer disabled:opacity-50"
            >
              <Trash2 size={10} strokeWidth={1.6} aria-hidden />
              删除
            </button>
          </div>
        ))}

        <div className="space-y-2 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <TextInput
              value={marketLink}
              placeholder="市场链接：http(s)://… 或本地目录路径"
              onChange={(e) => setMarketLink(e.target.value)}
              aria-label="添加市场链接"
            />
            <Button size="sm" variant="secondary" data-ui="mcp_market_preview" onClick={() => void handlePreview()} disabled={busy}>
              预览
            </Button>
            <Button size="sm" variant="primary" data-ui="mcp_market_add" onClick={() => void handleAdd()} disabled={busy || !preview?.ok}>
              <Plus size={11} strokeWidth={1.6} />
              添加市场
            </Button>
          </div>
          {preview?.ok && preview.preview ? (
            <div className="rounded-lg border border-[var(--ink-border)] px-3 py-2 text-[11px] leading-relaxed ink-text-muted" data-ui="mcp_market_preview_card">
              <span className="font-medium">{preview.preview.name}</span> · {preview.preview.server_count} 个服务
              · 低 {preview.preview.risk_summary.low} / 中 {preview.preview.risk_summary.medium} / 高 {preview.preview.risk_summary.high}
              <p className="mt-1 text-[10px] ink-text-faint">
                外部目录摄入：核对通过后确认添加即授权，服务挂载仍按各条目风险走既有闸门。
              </p>
            </div>
          ) : null}
          {notice ? (
            <p className="text-[10px] leading-relaxed ink-feedback-fail" data-ui="mcp_market_notice">
              {notice}
            </p>
          ) : null}
        </div>
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">联网搜索</div>
        <Field label="search_key" hint="env INK_SEARCH_KEY 显式优先、设置档兜底；仅本地持有。">
          <TextInput
            value={searchKey}
            onChange={(e) => setSearchKey(e.target.value)}
            aria-label="search_key"
            placeholder="sk-..."
          />
        </Field>
        <Field label="search_provider">
          <Select
            value={searchProvider}
            onChange={(e) => setSearchProvider(e.target.value as SearchProvider)}
            aria-label="search_provider"
          >
            <option value="exa">exa</option>
            <option value="parallel">parallel</option>
            <option value="bocha">bocha</option>
          </Select>
        </Field>
        <div className="flex items-center justify-end gap-2">
          <span className={[
            'text-[10px]',
            savePhase === 'saving' ? 'ink-text-muted' : '',
            savePhase === 'saved' ? 'ink-feedback-ok' : '',
            savePhase === 'error' ? 'ink-feedback-fail' : '',
          ].join(' ')}>
            {savePhase === 'saving' && '保存中…'}
            {savePhase === 'saved' && '已保存'}
            {savePhase === 'error' && '保存失败'}
          </span>
          <Button size="sm" variant="primary" onClick={handleSaveSearch} data-ui="search_keys_save">
            <Search size={11} strokeWidth={1.6} />
            保存搜索配置
          </Button>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed ink-text-faint">
        网络域名白名单与联网工具沙箱判定位于「工作区授权 → OS 层」。
      </p>
    </div>
  );
}
