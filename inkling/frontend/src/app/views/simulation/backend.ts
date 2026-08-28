export type SimulationPolicy = 'off' | 'light' | 'full';
export type BranchGroupKind = 'replan' | 'spawn' | 'decision' | 'multipath';

export const GROUP_LABEL: Record<BranchGroupKind, string> = {
  replan: '重规划',
  spawn: '拆解',
  decision: '决策',
  multipath: '多径',
};

export interface SimulationCandidate {
  id: string;
  /** 分支序号（多径/候选）。 */
  branch: number;
  title: string;
  score: number;
  rounds: number;
  cost: number;
  summary: string;
  diff?: string;
  selected: boolean;
}

export interface SimulationGroup {
  kind: BranchGroupKind;
  candidates: SimulationCandidate[];
}

export interface SimulationState {
  policy: SimulationPolicy;
  groups: SimulationGroup[];
  chosenId: string | null;
}

export interface SimulationBackend {
  fetchSimulation(): Promise<SimulationState | null>;
  chooseCandidate(id: string): Promise<void>;
  clearCandidate(): Promise<void>;
  setMultipath(enabled: boolean): Promise<void>;
}
