import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';

import type { SimulationBackend, SimulationState } from './backend';

/** 生产后端：经 adapter 真调用；缺 op 时返回 null（空态「本回合无推演决策点」）。 */
export function createLiveSimulationBackend(adapter: BackendAdapter = createBackend()): SimulationBackend {
  return {
    async fetchSimulation() {
      if (!adapter.available) return null;
      try {
        const res = (await adapter.pathAssemble()) as SimulationState | null;
        return res ?? null;
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
