import { useEffect, useState } from 'react';
import { GitFork } from 'lucide-react';

import { createLiveSimulationBackend } from './mockBackend';
import type { SimulationBackend, SimulationState } from './backend';
import { SimulationTree } from './SimulationTree';
import { SwapConfirm } from './SwapConfirm';
import { EmptyState } from '../EmptyState';

const POLICY_LABEL: Record<SimulationState['policy'], string> = {
  off: '关',
  light: '轻探测',
  full: '全量',
};

/** 推演视图：分支对比 + 换选确认（三按钮）+ 档位指示。 */
export function SimulationView({ backend = createLiveSimulationBackend() }: { backend?: SimulationBackend }) {
  // 稳定后端实例：默认参数在每次渲染都新建对象，直接进 useEffect 依赖会
  // 无限重渲（每次渲染 → 新 backend → effect 重跑 → setState → 重渲）。
  const [instance] = useState(() => backend);
  const [state, setState] = useState<SimulationState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [swapId, setSwapId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void instance.fetchSimulation().then((s) => {
      if (!alive) return;
      setState(s);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [instance]);

  if (!loaded) return <div className="w3-muted" data-testid="sim-loading">加载推演…</div>;

  if (!state || state.groups.length === 0) {
    return (
      <div className="w3" data-view="simulation">
        <EmptyState icon={GitFork} text="本回合无推演决策点" actionLabel="档位入口" onAction={() => undefined} />
      </div>
    );
  }

  const swapCandidate = state.groups.flatMap((g) => g.candidates).find((c) => c.id === swapId) ?? null;

  async function confirmSwap() {
    if (!swapCandidate) return;
    await instance.chooseCandidate(swapCandidate.id);
    setState((prev) =>
      prev
        ? {
            ...prev,
            chosenId: swapCandidate.id,
            groups: prev.groups.map((g) => ({
              ...g,
              candidates: g.candidates.map((c) => ({ ...c, selected: c.id === swapCandidate.id })),
            })),
          }
        : prev,
    );
    setSwapId(null);
  }

  return (
    <div className="w3" data-view="simulation">
      <div className="w3-summary-bar" data-testid="sim-summary">
        <span className="w3-metric">
          <strong>推演</strong>
        </span>
        <span className="w3-sep" />
        <span className="w3-badge w3-badge--neutral" data-testid="sim-policy" data-policy={state.policy}>
          档位 · {POLICY_LABEL[state.policy]}
        </span>
      </div>
      <div className="w3-body">
        <SimulationTree groups={state.groups} onSwap={(id) => setSwapId(id)} />
      </div>

      {swapCandidate && (
        <SwapConfirm
          branch={swapCandidate.branch}
          onConfirm={() => void confirmSwap()}
          onCancel={() => setSwapId(null)}
          onClear={async () => {
            await instance.clearCandidate();
            setState((prev) => (prev ? { ...prev, chosenId: null } : prev));
            setSwapId(null);
          }}
        />
      )}
    </div>
  );
}
