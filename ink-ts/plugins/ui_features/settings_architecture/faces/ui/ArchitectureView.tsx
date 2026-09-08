import { useState } from 'react';
import { Boxes, GitMerge } from 'lucide-react';

import { createLiveArchitectureBackend } from '@app/views/architecture/mockBackend';
import type { ArchitectureBackend } from '@app/views/architecture/backend';
import { PoolTab } from './tabs/PoolTab';
import { EdgeEvidenceTab } from './tabs/EdgeEvidenceTab';
import styles from './architecture.module.css';

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
    <div className={styles.root} data-view="architecture">
      <div className={styles.tabs} role="tablist">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
              data-testid={`arch-tab-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              <Icon size={14} strokeWidth={1.5} /> {t.label}
            </button>
          );
        })}
      </div>
      <div className={styles.body}>
        {tab === 'pool' && <PoolTab backend={instance} />}
        {tab === 'edge' && <EdgeEvidenceTab backend={instance} />}
      </div>
    </div>
  );
}
