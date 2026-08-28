import { useState } from 'react';
import { Boxes, GitBranch, GitMerge, Network } from 'lucide-react';

import { createLiveArchitectureBackend } from './mockBackend';
import type { ArchitectureBackend, AssemblyResult } from './backend';
import { TemplateTab } from './tabs/TemplateTab';
import { InstanceTab } from './tabs/InstanceTab';
import { PoolTab } from './tabs/PoolTab';
import { EdgeEvidenceTab } from './tabs/EdgeEvidenceTab';

type ArchTab = 'template' | 'instance' | 'pool' | 'edge';

const TABS: Array<{ id: ArchTab; label: string; icon: typeof GitBranch }> = [
  { id: 'template', label: '模板', icon: GitBranch },
  { id: 'instance', label: '实例', icon: Network },
  { id: 'pool', label: '结点池', icon: Boxes },
  { id: 'edge', label: '边证据', icon: GitMerge },
];

/** 架构视图容器：四层 tab（模板/实例/池/边证据）。 */
export function ArchitectureView({
  backend = createLiveArchitectureBackend(),
  assemblyResult = null,
  onOpenAssembly,
}: {
  backend?: ArchitectureBackend;
  assemblyResult?: AssemblyResult | null;
  onOpenAssembly?: () => void;
}) {
  const [tab, setTab] = useState<ArchTab>('template');

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
        {tab === 'template' && <TemplateTab backend={backend} />}
        {tab === 'instance' && <InstanceTab backend={backend} />}
        {tab === 'pool' && <PoolTab backend={backend} />}
        {tab === 'edge' && <EdgeEvidenceTab backend={backend} assemblyResult={assemblyResult} onOpenAssembly={onOpenAssembly} />}
      </div>
    </div>
  );
}
