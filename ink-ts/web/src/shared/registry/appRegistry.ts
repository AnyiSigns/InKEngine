/**
 * 应用注册表（管理台数据抽象）：组件/工具/挂载/执行体的三来源清单。
 *
 * 三来源分组：
 * - baseline 出厂基线：不可卸载，可停用（移出引用）/ 重置（链清空）；
 * - mcp MCP 挂载新增：可卸载（移除后回市场态）；
 * - ai AI 自写组件 + 执行体：可卸载（链上产物，随补丁链可回退）。
 * 状态/最近变化/关联补丁链 ID 全量携带；变更经 store 回写（可注入，
 * 宿主接线引擎侧 registry 后替换）。
 */

export type RegistrySource = 'baseline' | 'mcp' | 'ai';
export type RegistryEntryType = 'component' | 'tool' | 'mcp_server' | 'executor' | 'manifest';
export type RegistryStatus = 'active' | 'disabled';

export interface AppRegistryEntry {
  id: string;
  name: string;
  type: RegistryEntryType;
  version: string;
  source: RegistrySource;
  status: RegistryStatus;
  changedAt: number;
  patchChainId?: string;
  description?: string;
}

export interface AppRegistryStore {
  list(): AppRegistryEntry[];
  disable(id: string): void;
  reset(id: string): void;
  uninstall(id: string): void;
  subscribe(listener: () => void): () => void;
}

type RegistryListener = () => void;

export class MemoryAppRegistryStore implements AppRegistryStore {
  private entries: AppRegistryEntry[];
  private listeners = new Set<RegistryListener>();

  constructor(seed: AppRegistryEntry[] = []) {
    this.entries = seed.map((entry) => ({ ...entry }));
  }

  list(): AppRegistryEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  disable(id: string): void {
    if (this.getEntry(id)?.source !== 'baseline') return;
    this.entries = this.entries.map((entry) => {
      if (entry.id !== id) return entry;
      // 停用 = 移出引用（不删除产物）
      return { ...entry, status: entry.status === 'active' ? 'disabled' : 'active' };
    });
    this.commit();
  }

  reset(id: string): void {
    if (this.getEntry(id)?.source !== 'baseline') return;
    this.entries = this.entries.map((entry) =>
      entry.id === id ? { ...entry, patchChainId: undefined, status: 'active', version: '出厂版' } : entry,
    );
    this.commit();
  }

  uninstall(id: string): void {
    const entry = this.getEntry(id);
    if (!entry || entry.source === 'baseline') return;
    this.entries = this.entries.filter((candidate) => candidate.id !== id);
    this.commit();
  }

  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private getEntry(id: string): AppRegistryEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  private commit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const REGISTRY_SOURCE_LABELS: Record<RegistrySource, string> = {
  baseline: '出厂基线',
  mcp: 'MCP 挂载',
  ai: 'AI 自写',
};

export const REGISTRY_TYPE_LABELS: Record<RegistryEntryType, string> = {
  component: '渲染组件',
  tool: '工具',
  mcp_server: 'MCP 服务',
  executor: '执行体',
  manifest: '清单',
};
