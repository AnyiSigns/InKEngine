/**
 * 设置页后端通道封装（壳桥 op 映射层）。
 *
 * 只 import 不改动 src/shared/backend/backendAdapter.ts；
 * 设置页专用读写在注册项 read/write 内联；批量保存走
 * capability_put / offline_settings_put 等既有契约。
 */

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';

export interface SettingsBackend {
  available: boolean;
  status(): Promise<{ engine_ready: boolean; first_run?: boolean }>;
  firstRunDismiss(): Promise<{ dismissed: boolean }>;
  modelsSnapshot(): Promise<Record<string, unknown>>;
  capabilityGet(): Promise<Record<string, unknown>>;
  capabilityPut(record: Record<string, unknown>): Promise<unknown>;
  offlineSettingsGet(): Promise<Record<string, unknown>>;
  offlineSettingsPut(settings: Record<string, unknown>): Promise<unknown>;
  metricsSnapshot(): Promise<Record<string, unknown>>;
  assembleStats(): Promise<Record<string, unknown>>;
  cacheInvalidate(scope: string): Promise<{ cleared: string }>;
  voiceStatus(): Promise<Record<string, unknown>>;
  offlineDetect(): Promise<Record<string, unknown>>;
  backendStatus(): Promise<Record<string, unknown>>;
}

export function createSettingsBackend(adapter: BackendAdapter | null): SettingsBackend {
  const tauri = createTauriInvoker();
  const direct = (cmd: string, args?: Record<string, unknown>) =>
    tauri?.invoke(cmd, args).then((r) => r as Record<string, unknown>) ?? Promise.resolve({});

  if (!adapter?.available) {
    return {
      available: false,
      status: async () => ({ engine_ready: false }),
      firstRunDismiss: async () => ({ dismissed: false }),
      modelsSnapshot: async () => ({}),
      capabilityGet: async () => ({}),
      capabilityPut: async () => undefined,
      offlineSettingsGet: () => direct('offline_settings_get'),
      offlineSettingsPut: (settings) => direct('offline_settings_put', { settings }),
      metricsSnapshot: async () => ({}),
      assembleStats: async () => ({}),
      cacheInvalidate: (scope) => adapter?.invalidateCache(scope) ?? Promise.resolve({ cleared: 'unavailable' as const }),
      voiceStatus: () => direct('voice_status'),
      offlineDetect: () => direct('offline_detect'),
      backendStatus: async () => ({}),
    };
  }

  return {
    available: true,
    status: () => adapter.status().then((s) => ({ engine_ready: s.engine_ready, first_run: s.first_run })),
    firstRunDismiss: () => adapter.firstRunDismiss(),
    modelsSnapshot: () => adapter.modelsSnapshot().then((r) => r as unknown as Record<string, unknown>),
    capabilityGet: () => adapter.capabilityGet().then((r) => r as unknown as Record<string, unknown>),
    capabilityPut: (record) => adapter.capabilityPut(record),
    offlineSettingsGet: () => direct('offline_settings_get'),
    offlineSettingsPut: (settings) => direct('offline_settings_put', { settings }),
    metricsSnapshot: () => adapter.metricsSnapshot().then((r) => r as unknown as Record<string, unknown>),
    assembleStats: () => adapter.assembleStats().then((r) => r as unknown as Record<string, unknown>),
    cacheInvalidate: (scope) => adapter.invalidateCache(scope),
    voiceStatus: () => direct('voice_status'),
    offlineDetect: () => direct('offline_detect'),
    backendStatus: () => adapter.status().then((s) => s as unknown as Record<string, unknown>),
  };
}
