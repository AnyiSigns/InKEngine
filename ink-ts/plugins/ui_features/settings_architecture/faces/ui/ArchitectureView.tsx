import { useState } from 'react';
import { Boxes, GitMerge } from 'lucide-react';

import '@app/views/w3.css';
import { createLiveArchitectureBackend } from '@app/views/architecture/mockBackend';
import type { ArchitectureBackend } from '@app/views/architecture/backend';
import { PoolTab } from './tabs/PoolTab';
import { EdgeEvidenceTab } from './tabs/EdgeEvidenceTab';

type ArchTab = 'pool' | 'edge';

const TABS: Array<{ id: ArchTab; label: string; icon: typeof GitMerge }> = [
  { id: 'pool', label: '结点池', icon: Boxes },
  { id: 'edge', label: '边证据', icon: GitMerge },
];

/** 架构视图容器：结点池/边证据（只读投影）。模板编辑/试跑为假演示已移除。 */
export function ArchitectureView({
  backend = createLiveArchitectureBackend(),
}: {
  backend?: ArchitectureBackend;
}) {
  // 稳定后端实例：默认参数每次渲染新建对象，直接传给子 tab 会使其
  // useEffect[backend] 每次渲染重跑（无限重渲循环）。
  const [instance] = useState(() => backend);
  const [tab, setTab] = useState<ArchTab>('pool');

  return (
    <div className="w3" data-view="architecture">
      <div className="w3-tabs" role="tablist">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`w3-tab ${tab === t.id ? 'w3-tab--active' : ''}`}
              data-testid={`arch-tab-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              <Icon size={14} strokeWidth={1.5} /> {t.label}
            </button>
          );
        })}
      </div>
      <div className="w3-body">
        {tab === 'pool' && <PoolTab backend={instance} />}
        {tab === 'edge' && <EdgeEvidenceTab backend={instance} />}
      </div>
    </div>
  );
}
