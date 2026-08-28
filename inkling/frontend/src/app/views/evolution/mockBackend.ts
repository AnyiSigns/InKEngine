import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';

import type {
  Convergence,
  EvolutionBackend,
  EvolutionProposal,
  EvolutionVariant,
  FixturesStatus,
  IncubationState,
  KnowledgeCandidate,
  TimelineNode,
} from './backend';

/** 生产后端：缺口 op 一律 null（列表级降级）。 */
export function createLiveEvolutionBackend(adapter: BackendAdapter = createBackend()): EvolutionBackend {
  void adapter;
  return {
    async fetchIncubation() {
      return null;
    },
    async fetchProposals() {
      return null;
    },
    async applyProposal() {},
    async revertProposal() {},
    async editProposal() {},
    async fetchTimeline() {
      return null;
    },
    async fetchConvergence() {
      return null;
    },
    async fetchKnowledgeCandidates() {
      return null;
    },
    async releaseKnowledge() {},
    async fetchVariants() {
      return null;
    },
    async fetchFixtures() {
      return null;
    },
  };
}

/** 测试后端：注入夹具。 */
export function createMockEvolutionBackend(fixtures: {
  incubation?: IncubationState | null;
  proposals?: EvolutionProposal[] | null;
  timeline?: TimelineNode[] | null;
  convergence?: Record<string, Convergence | null>;
  knowledge?: KnowledgeCandidate[] | null;
  variants?: EvolutionVariant[] | null;
  fixtures?: FixturesStatus | null;
}): EvolutionBackend {
  return {
    async fetchIncubation() {
      return fixtures.incubation ?? null;
    },
    async fetchProposals() {
      return fixtures.proposals ?? null;
    },
    async applyProposal() {},
    async revertProposal() {},
    async editProposal() {},
    async fetchTimeline() {
      return fixtures.timeline ?? null;
    },
    async fetchConvergence(id: string) {
      return fixtures.convergence?.[id] ?? null;
    },
    async fetchKnowledgeCandidates() {
      return fixtures.knowledge ?? null;
    },
    async releaseKnowledge() {},
    async fetchVariants() {
      return fixtures.variants ?? null;
    },
    async fetchFixtures() {
      return fixtures.fixtures ?? null;
    },
  };
}
