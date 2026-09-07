import type { ReactNode } from 'react';

export type SettingsItemKind = 'text' | 'secret' | 'select' | 'toggle' | 'custom';

export interface SettingsItemSpec {
  key: string;
  label: string;
  hint?: string;
  kind: SettingsItemKind;
  options?: Array<{ value: string; label: string }>;
  read: () => Promise<unknown>;
  write?: (value: unknown) => Promise<void>;
  disabledReason?: string;
  validate?: (value: unknown) => string | null;
}

export interface SettingsSectionSpec {
  key: string;
  label: string;
  icon: ReactNode;
  order: number;
  items?: SettingsItemSpec[];
  render?: () => React.ReactNode;
}
