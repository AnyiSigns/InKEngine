export interface TaskCapsuleData {
  goal: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  step: number;
  total: number;
  next_step?: string;
}

export interface RoundTaskSummaryData {
  goal: string;
  status: string;
  changed_files: string[];
  next_step: string;
  summary_ref: string;
}
