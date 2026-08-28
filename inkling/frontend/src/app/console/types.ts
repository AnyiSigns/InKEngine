export type ConsoleSectionId = 'registry' | 'tasks' | 'ledger' | 'memory' | 'backup' | 'audit' | 'lifecycle' | 'insights' | 'voice' | 'appearance' | 'about';

export interface ConsoleSectionDef {
  id: ConsoleSectionId;
  label: string;
  icon?: string;
}

export const CONSOLE_SECTIONS: ConsoleSectionDef[] = [
  { id: 'registry', label: '注册表' },
  { id: 'tasks', label: '任务' },
  { id: 'ledger', label: '账本' },
  { id: 'memory', label: '记忆' },
  { id: 'backup', label: '备份' },
  { id: 'audit', label: '审计' },
  { id: 'lifecycle', label: '生命周期' },
  { id: 'insights', label: '洞察' },
  { id: 'voice', label: '语音' },
  { id: 'appearance', label: '外观' },
  { id: 'about', label: '关于' },
];
