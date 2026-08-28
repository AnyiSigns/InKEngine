/**
 * 设置「连接」节：MCP 服务连接管理入口 + 搜索 key 配置。
 *
 * MCP 挂载唯一真路径 = MCP 市场（出厂零预挂；一键挂载走 vetting → 观察
 * → L2 审批转正 → 补丁链可回退），本节提供入口行，不做本地假挂载清单。
 * 搜索 key 配置项（env INK_SEARCH_KEY 显式优先、设置档兜底；降级 = 用户
 * 自配 exa/parallel key/bocha），即改即存。
 * 网络白名单判定面归 OS 层沙箱（开发者模式 → OS 层），不在用户设置重复。
 */

import { useState } from 'react';

import { ChevronRight, Search, Server } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Field, Select, TextInput } from '@/shared/ui/Field';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';
import { SettingsActionsContext } from './advanced_section';
import { useContext } from 'react';

type SearchProvider = 'exa' | 'parallel' | 'bocha';

export function ConnectSection(): JSX.Element {
  const { onOpenView } = useContext(SettingsActionsContext);
  const tauri = createTauriInvoker();
  const [searchKey, setSearchKey] = useState('');
  const [searchProvider, setSearchProvider] = useState<SearchProvider>('exa');
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleSaveSearch = async (): Promise<void> => {
    setSavePhase('saving');
    try {
      if (tauri) {
        await tauri.invoke('search_keys_put', {
          keys: { search_key: searchKey, search_provider: searchProvider },
        });
      }
      setSavePhase('saved');
      setTimeout(() => setSavePhase('idle'), 1200);
    } catch {
      setSavePhase('error');
      setTimeout(() => setSavePhase('idle'), 2000);
    }
  };

  return (
    <div className="space-y-4">
      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
        <button
          type="button"
          data-ui="connect_open_mcp_market"
          onClick={() => onOpenView('mcp_market')}
          className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-[var(--ink-bg-surface)]"
        >
          <Server size={16} strokeWidth={1.6} className="shrink-0 ink-text-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">MCP 服务</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed ink-text-faint">
              浏览市场并挂载；出厂零预挂，挂载经审查后生效、可回退
            </span>
          </span>
          <ChevronRight size={15} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
        </button>
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
        网络域名白名单与联网工具沙箱判定位于「开发者模式 → OS 层」。
      </p>
    </div>
  );
}
