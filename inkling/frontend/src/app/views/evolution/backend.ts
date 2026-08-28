import type { DiffLine } from '@/app/views/architecture/backend';

export type SignalType = 'pitfall' | 'correction' | 'insight' | 'gap' | 'repeated_root_cause';
export type GateVerdict = 'pass' | 'neutral' | 'fail';
export type ProposalLevel = 0 | 1 | 2;

export const SIGNAL_LABEL: Record<SignalType, string> = {
  pitfall: '踩坑',
  correction: '纠正',
  insight: '洞察',
  gap: '缺口',
  repeated_root_cause: '反复根因',
};

export interface SignalExample {
  event: string;
  confidence: number;
}
export interface SignalBucket {
  type: SignalType;
  count: number;
  examples: SignalExample[];
}
export interface IncubationState {
  signals: SignalBucket[];
  distill: { summary: string; evidenceCount: number };
  gate: { verdict: GateVerdict; note: string };
}

export interface EvolutionProposal {
  id: string;
  level: ProposalLevel;
  title: string;
  diff?: DiffLine[];
  sandboxResult?: string;
  applied?: boolean;
  reverted?: boolean;
}

export interface TimelineNode {
  id: string;
  version: string;
  solid: boolean;
  fork?: boolean;
  diff?: DiffLine[];
}

export interface ReviewDimension {
  name: string;
  score: number;
  threshold: number;
  passed: boolean;
}
export interface Convergence {
  rounds: { current: number; total: number };
  dimensions: ReviewDimension[];
  failing: string[];
  beam: { candidateA: number; candidateB: number };
}

export interface KnowledgeCandidate {
  id: string;
  content: string;
  dimensions: ReviewDimension[];
  note?: string;
  released?: boolean;
}

export interface EvolutionVariant {
  id: string;
  label: string;
  summary: string;
}

export interface FixturesStatus {
  allGreen: boolean;
  failedCount: number;
}

export interface EvolutionBackend {
  fetchIncubation(): Promise<IncubationState | null>;
  fetchProposals(): Promise<EvolutionProposal[] | null>;
  applyProposal(id: string): Promise<void>;
  revertProposal(id: string): Promise<void>;
  editProposal(id: string, text: string): Promise<void>;
  fetchTimeline(): Promise<TimelineNode[] | null>;
  fetchConvergence(id: string): Promise<Convergence | null>;
  fetchKnowledgeCandidates(): Promise<KnowledgeCandidate[] | null>;
  releaseKnowledge(id: string, note?: string): Promise<void>;
  fetchVariants(): Promise<EvolutionVariant[] | null>;
  fetchFixtures(): Promise<FixturesStatus | null>;
}
