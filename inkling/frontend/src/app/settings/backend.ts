/**
 * 设置页后端通道封装（单一 IPC 面：全部经 BackendAdapter 下发）。
 *
 * 设置页不再持有独立 tauri invoke 通道——offline_settings_get/put、
 * voice_status、offline_detect 等命令已并入 BackendAdapter 接口，
 * 与主会话共用同一传输与统一错误信封收口（code/message/trace_id 记日志）。
 */

import type { BackendAdapter } from '@/shared/backend/backendAdapter';

export interface SettingsBackend {
  available: boolean;
  status(): Promise<{ engine_ready: boolean; first_run?: boolean }>;
  firstRunDismiss(): Promise<{ dismissed: boolean }>;
  modelArchiveSnapshot(): Promise<Record<string, unknown>>;
  capabilityGet(): Promise<Record<string, unknown>>;
  capabilityPut(record: Record<string, unknown>): Promise<unknown>;
  offlineSettingsGet(): Promise<Record<string, unknown>>;
  offlineSettingsPut(settings: Record<string, unknown>): Promise<unknown>;
  metricsSnapshot(): Promise<Record<string, unknown>>;
  assembleStats(): Promise<Record<string, unknown>>;
  cacheInvalidate(scope: string): Promise<Record<string, unknown>>;
  voiceStatus(): Promise<Record<string, unknown>>;
  offlineDetect(): Promise<Record<string, unknown>>;
  backendStatus(): Promise<Record<string, unknown>>;
}

const UNAVAILABLE: SettingsBackend = {
  available: false,
  status: async () => ({ engine_ready: false }),
  firstRunDismiss: async () => ({ dismissed: false }),
  modelArchiveSnapshot: async () => ({}),
  capabilityGet: async () => ({}),
  capabilityPut: async () => undefined,
  offlineSettingsGet: async () => ({}),
  offlineSettingsPut: async () => undefined,
  metricsSnapshot: async () => ({}),
  assembleStats: async () => ({}),
  cacheInvalidate: async () => ({ cleared: 'unavailable' }),
  voiceStatus: async () => ({}),
  offlineDetect: async () => ({}),
  backendStatus: async () => ({}),
};

export function createSettingsBackend(adapter: BackendAdapter | null): SettingsBackend {
  if (!adapter?.available) return UNAVAILABLE;

  return {
    available: true,
    status: () => adapter.status().then((s) => ({ engine_ready: s.engine_ready, first_run: s.first_run })),
    firstRunDismiss: () => adapter.firstRunDismiss(),
    modelArchiveSnapshot: () => adapter.modelArchiveSnapshot().then((r) => r as unknown as Record<string, unknown>),
    capabilityGet: () => adapter.capabilityGet().then((r) => r as unknown as Record<string, unknown>),
    capabilityPut: (record) => adapter.capabilityPut(record),
    offlineSettingsGet: () => adapter.offlineSettingsGet(),
    offlineSettingsPut: (settings) => adapter.offlineSettingsPut(settings),
    metricsSnapshot: () => adapter.metricsSnapshot().then((r) => r as unknown as Record<string, unknown>),
    assembleStats: () => adapter.assembleStats().then((r) => r as unknown as Record<string, unknown>),
    cacheInvalidate: (scope) => adapter.invalidateCache(scope),
    voiceStatus: () => adapter.voiceStatus(),
    offlineDetect: () => adapter.offlineDetect(),
    backendStatus: () => adapter.status().then((s) => s as unknown as Record<string, unknown>),
  };
}
