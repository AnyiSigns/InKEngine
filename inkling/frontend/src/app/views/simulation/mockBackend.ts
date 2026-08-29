import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';

import type { SimulationBackend, SimulationGroup, SimulationPolicy, SimulationState } from './backend';

/**
 * 生产后端：把 path.assemble 的返回结构映射成 SimulationState（引擎候选 →
 * 决策分支组）。op 未启用/无候选 = null（空态「本回合无推演决策点」），
 * 绝不把原始结构泄漏给渲染层（避免类型谎言导致 state.groups 崩溃）。
 */
export function createLiveSimulationBackend(adapter: BackendAdapter = createBackend()): SimulationBackend {
  return {
    async fetchSimulation(): Promise<SimulationState | null> {
      if (!adapter.available) return null;
      try {
        const res = (await adapter.pathAssemble()) as
          | {
              ok?: boolean;
              enabled?: boolean;
              candidates?: Array<{
                id?: unknown;
                path?: unknown;
                description?: unknown;
                name?: unknown;
                score?: unknown;
                summary?: unknown;
                rationale?: unknown;
                branch?: unknown;
              }>;
              exploration_mode?: unknown;
              reason?: unknown;
            }
          | null;
        if (!res || res.ok === false) return null;
        const candidates = res.candidates ?? [];
        if (!candidates.length) return null;
        const group: SimulationGroup = {
          kind: 'decision',
          candidates: candidates.map((c, i) => ({
            id: String(c.id ?? c.path ?? `c${i + 1}`),
            branch: Number(c.branch ?? i),
            title: String(c.path ?? c.description ?? c.name ?? `候选 ${i + 1}`),
            score: Number(c.score ?? 0),
            rounds: 0,
            cost: 0,
            summary: String(c.summary ?? c.rationale ?? ''),
            diff: undefined,
            selected: i === 0,
          })),
        };
        const policy: SimulationPolicy = res.exploration_mode === true ? 'light' : 'full';
        const chosenId = group.candidates.find((c) => c.selected)?.id ?? null;
        return { policy, groups: [group], chosenId };
      } catch {
        return null;
      }
    },
    async chooseCandidate(id: string) {
      await adapter.chooseCandidate(id);
    },
    async clearCandidate() {
      await adapter.pathClearCandidate();
    },
    async setMultipath(enabled: boolean) {
      await adapter.setMultipath(enabled);
    },
  };
}

/** 测试后端：注入夹具。 */
export function createMockSimulationBackend(fixtures: { state?: SimulationState | null }): SimulationBackend {
  return {
    async fetchSimulation() {
      return fixtures.state ?? null;
    },
    async chooseCandidate() {},
    async clearCandidate() {},
    async setMultipath() {},
  };
}
