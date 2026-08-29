import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';

import { DagRenderer } from '@/app/dag';
import { EmptyState } from '../../EmptyState';
import { useSettingsThread } from '@/app/settings/settings_floater';
import type { ArchitectureBackend, InstanceGraph } from '../backend';
import { GitBranch } from 'lucide-react';

/** 实例 tab：最近回合实际跑的图（只读）。node_start/end 执行态追踪。 */
export function InstanceTab({ backend }: { backend: ArchitectureBackend }) {
  const [instance, setInstance] = useState<InstanceGraph | null>(null);
  const [loaded, setLoaded] = useState(false);
  const threadId = useSettingsThread();

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    void backend.fetchInstanceGraph(threadId || undefined).then((g) => {
      if (!alive) return;
      setInstance(g);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [backend, threadId]);

  if (!loaded) return <div className="w3-muted" data-testid="inst-loading">加载实例图…</div>;

  if (!instance) {
    return <EmptyState icon={GitBranch} text="暂无本回合实例图" />;
  }

  // node_start/end 执行态注入图节点（实例图只读，状态来自回合事件，不来自模板）
  const graph = {
    ...instance.graph,
    nodes: instance.graph.nodes.map((n) => ({ ...n, status: instance.nodeStatus[n.id] ?? n.status })),
  };

  return (
    <div className="w3-stack">
      <div className="w3-panel" data-readonly="true">
        <div className="w3-panel-title">
          <Lock size={14} strokeWidth={1.5} /> 实例图（只读）
        </div>
        <div className="w3-muted">最近回合 {instance.roundId} 实际图，派生物不编辑。</div>
        <div style={{ height: 320, marginTop: 12 }}>
          <DagRenderer
            graph={graph}
            ariaLabel={`回合 ${instance.roundId} 实例图`}
            onNodeClick={() => undefined}
          />
        </div>
        <div className="w3-row" style={{ marginTop: 12 }}>
          {(['running', 'success', 'failed'] as const).map((s) => (
            <span key={s} className="w3-badge" data-status-legend={s}>
              {s === 'running' ? '进行中' : s === 'success' ? '成功' : '失败'}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
