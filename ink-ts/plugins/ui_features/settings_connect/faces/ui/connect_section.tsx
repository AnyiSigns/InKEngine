/**
 * 设置「连接」节：联网搜索 key 配置。
 *
 * MCP 服务启停/连接态在设置「插件」段（服务分组 = MCP 工具型插件，
 * mcp.status/enable/disable，B5）；本页只承载搜索 key 配置项（env
 * INK_SEARCH_KEY 显式优先、设置档兜底），即改即存。
 */

import { useRef, useState } from 'react';

import { Search } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Field, Select, TextInput } from '@/shared/ui/Field';
import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';

type SearchProvider = 'exa' | 'parallel' | 'bocha';

export function ConnectSection({ backend: injectedBackend }: { backend?: BackendAdapter } = {}): JSX.Element {
  // BackendAdapter 单通道：搜索 key 经适配器（可 mock/可回落）；壳内取声明
  // 注入的共享实例，壳外（测试/独立挂载）缺省回落自建。
  const [backend] = useState(() => injectedBackend ?? createBackend());
  const [searchKey, setSearchKey] = useState('');
  const [searchProvider, setSearchProvider] = useState<SearchProvider>('exa');
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSavePhase('idle'), 1200);
    } catch {
      setSavePhase('error');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSavePhase('idle'), 2000);
    }
  };

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">联网搜索</div>
        <Field label="search_key" hint="env INK_SEARCH_KEY 显式优先、设置档兜底；仅本地持有。">
          <TextInput
            type="password"
            autoComplete="off"
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
        MCP 市场浏览与挂载见「市场」节；网络域名白名单与联网工具沙箱判定位于
        「工作区授权 → OS 层」。
      </p>
    </div>
  );
}
