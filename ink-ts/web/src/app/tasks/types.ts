export interface TaskCapsuleData {
  goal: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  step: number;
  total: number;
  next_step?: string;
}
