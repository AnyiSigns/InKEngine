/**
 * App 视图层后端封装：面向各视图提供类型化的后端访问接口。
 *
 * 职责：
 * - 组件市场（W4）：获取 components_manifest，动态注册 artifact 组件；
 * - 工具面板（W5.2）：获取 tools_snapshot，按族分组；
 * - MCP 市场（W5.1）：从种子 mcp_market.json 驱动（无后端依赖）；
 * - 工作区授权（W5.5）：获取 authorization_state，执行 workspace_authorize/revoke；
 * - OS 层（W5.3）：复用 tools_snapshot + authorization_state；
 *
 * 宿主不可用（浏览器 dev / 无壳）时回落到种子数据夹具：视图仍可渲染，
 * 仅挂载/授权类操作在无宿主时降级为本地状态记录。
 */

import { createBackend, type BackendAdapter, type ArtifactManifestEntry, type ToolSnapshotEntry, type BackendStatus, type KnowledgeGraphResult } from '@/shared/backend/backendAdapter';
import { registerArtifactManifest } from '@/renderer/artifactLoader';
import { logger } from '@/shared/logger';
import { ChannelHub, type SessionSnapshot, type HubEvent } from '@/shared/session/channelHub';
import { isEventTypeName } from '@/shared/session/eventTypes';
import type { UISpec } from '@/renderer/uiSpecTypes';

import { isFixtureMode } from './wiring/env';

import type { McpMarketEntry, ComponentMarketEntry, ToolDetail } from './types';

import mcpMarketSeed from '../../../seed_data/mcp_market.json';
import componentsMarketSeed from '../../../seed_data/components_market.json';
import toolsSeed from '../../../seed_data/tools.json';
import uiSpecSeed from '../../../seed_data/ui_spec.json';

export interface AppBackendOptions {
  backend?: BackendAdapter | null;
  channelHub?: ChannelHub | null;
}

/**
 * App 视图层后端服务：封装 BackendAdapter + 种子数据夹具。
 * 生产环境走宿主桥；浏览器 dev 回退种子数据。
 */
export class AppBackend {
  private backend: BackendAdapter | null;
  private hub: ChannelHub | null;
  public readonly available: boolean;

  constructor(options: AppBackendOptions = {}) {
    this.backend = options.backend ?? createBackend();
    this.hub = options.channelHub ?? null;
    this.available = this.backend?.available ?? false;
  }

  /** 后端状态快照 */
  async getStatus(): Promise<BackendStatus | null> {
    if (!this.backend?.available) return null;
    try {
      return await this.backend.status();
    } catch (err) {
      logger.warn('app', '获取后端状态失败', { err: String(err) });
      return null;
    }
  }

  /**
   * 组件清单刷新（W4.3）：
   * 拉取 components_manifest → artifactLoader.registerArtifactManifest → 动态注册。
   * 宿主不可用 = 零注册（既有组件照常）。
   */
  async refreshComponentManifest(): Promise<ArtifactManifestEntry[]> {
    if (!this.backend?.available) return [];
    try {
      const manifest = await this.backend.componentsManifest();
      const entries = manifest.artifacts ?? [];
      const count = registerArtifactManifest(entries);
      logger.info('app', '组件清单已刷新', { count, total: entries.length });
      return entries;
    } catch (err) {
      logger.warn('app', '组件清单刷新失败', { err: String(err) });
      return [];
    }
  }

  /** tools_snapshot（W5.2）：仅从后端获取，不从 collect_specs。 */
  async getToolsSnapshot(): Promise<ToolSnapshotEntry[]> {
    if (!this.backend?.available) return [];
    try {
      const result = await this.backend.toolsSnapshot();
      return result.tools ?? [];
    } catch (err) {
      logger.warn('app', '获取工具快照失败', { err: String(err) });
      return [];
    }
  }

  /** MCP 市场数据：从种子 mcp_market.json 驱动；演示态外不内嵌夹具。 */
  getMcpMarket(): McpMarketEntry[] {
    if (!isFixtureMode()) return [];
    return (mcpMarketSeed as { servers?: unknown[] }).servers?.map((s) => s as unknown as McpMarketEntry) ?? [];
  }

  /** 组件市场数据：从种子 components_market.json 驱动；演示态外不内嵌夹具。 */
  getComponentMarket(): ComponentMarketEntry[] {
    if (!isFixtureMode()) return [];
    return (componentsMarketSeed as { components?: ComponentMarketEntry[] }).components ?? [];
  }

  /** 组件市场挂载策略 */
  getComponentMountPolicy(): { required: string[]; note: string } {
    const seed = componentsMarketSeed as { mount_policy?: { required?: string[]; note?: string } };
    return {
      required: seed.mount_policy?.required ?? [],
      note: seed.mount_policy?.note ?? '',
    };
  }

  /** MCP 市场挂载策略 */
  getMcpMountPolicy(): { required: string[]; note: string } {
    const seed = mcpMarketSeed as { mount_policy?: { required?: string[]; note?: string } };
    return {
      required: seed.mount_policy?.required ?? [],
      note: seed.mount_policy?.note ?? '',
    };
  }

  /** MCP 出厂零预挂标记 */
  isMcpPremounted(): boolean {
    return (mcpMarketSeed as { premounted?: boolean }).premounted ?? false;
  }

  /** 组件出厂零预挂标记 */
  isComponentPremounted(): boolean {
    return (componentsMarketSeed as { premounted?: boolean }).premounted ?? false;
  }

  /**
   * 工具详情（行为手册）：从种子 tools.json 驱动完整 schema。
   * 供工具面板的详情抽屉展示（description/参数 schema/权限档/端点）。
   */
  getToolDetails(): ToolDetail[] {
    if (!isFixtureMode()) return [];
    return (toolsSeed as { tools?: unknown[] }).tools?.map((t) => t as unknown as ToolDetail) ?? [];
  }

  /** 获取指定工具的详情 */
  getToolDetail(name: string): ToolDetail | null {
    return this.getToolDetails().find((t) => t.name === name) ?? null;
  }

  /**
   * ui_spec 拉取（W4.1）。
   * 生产环境通过 inspect_ui introspection 拉取；宿主不可用时
   * 回落种子 ui_spec.json（dev 夹具）。
   */
  async getUiSpec(): Promise<UISpec | null> {
    if (!this.backend?.available) {
      return isFixtureMode() ? (uiSpecSeed as unknown as UISpec) : null;
    }
    try {
      const rec = (await this.backend.capabilityGet()) as Record<string, unknown>;
      return (rec?.ui_spec as UISpec) ?? (isFixtureMode() ? (uiSpecSeed as unknown as UISpec) : null);
    } catch (err) {
      logger.warn('app', '获取 ui_spec 失败', { err: String(err) });
      return isFixtureMode() ? (uiSpecSeed as unknown as UISpec) : null;
    }
  }

  /**
   * ui_spec 保存（W4.2）：产物 → 补丁链 → 落链。
   * 宿主不可用时记录到日志（dev 回退）。
   */
  async saveUiSpec(spec: UISpec): Promise<{ applied: boolean }> {
    if (!this.backend?.available) {
      logger.info('app', 'ui_spec 保存（dev 回退）', { version: spec.version, name: spec.name });
      return { applied: true };
    }
    try {
      await this.backend.capabilityPut({ ui_spec: spec });
      return { applied: true };
    } catch (err) {
      logger.warn('app', '保存 ui_spec 失败', { err: String(err) });
      return { applied: false };
    }
  }

  /**
   * ui_spec 回退（W4.2）：回退到上一稳定版本。
   * 宿主不可用时 dev 回退（成功）。
   */
  async revertUiSpec(): Promise<{ reverted: boolean; chain_version?: number }> {
    if (!this.backend?.available) {
      logger.info('app', 'ui_spec 回退（dev 回退）');
      return { reverted: true, chain_version: 0 };
    }
    try {
      const list = await this.backend.recoverySnapshots();
      const snapshots = list.snapshots ?? [];
      if (snapshots.length === 0) return { reverted: false };
      const latest = snapshots.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      const result = await this.backend.recoveryRestoreSnapshot(latest.name);
      return { reverted: true, ...(result.chain_version !== undefined ? { chain_version: result.chain_version } : {}) };
    } catch (err) {
      logger.warn('app', '回退 ui_spec 失败', { err: String(err) });
      return { reverted: false };
    }
  }

  /**
   * 打开路径（W5.5 工作区授权视图使用）：在系统文件管理器中打开授权工作区。
   * 宿主不可用时不执行任何操作。
   */
  openPath(path: string): void {
    if (!this.backend?.available) {
      logger.info('app', '打开路径（dev 回退）', { path });
      return;
    }
    void this.backend
      .openPath(path)
      .then(() => logger.info('app', '打开路径', { path }))
      .catch((err) => logger.warn('app', '打开路径失败', { path, err: String(err) }));
  }

  /**
   * 工作区授权状态（W5.5）。
   */
  async getAuthorizationState(): Promise<{ authorized: boolean; root: string | null }> {
    if (!this.backend?.available) return { authorized: false, root: null };
    try {
      return await this.backend.authorizationState();
    } catch (err) {
      logger.warn('app', '获取授权状态失败', { err: String(err) });
      return { authorized: false, root: null };
    }
  }

  /**
   * 工作区授权（W5.5）：授权访问指定路径。
   */
  async authorizeWorkspace(path: string): Promise<{ authorized: boolean; root: string } | null> {
    if (!this.backend?.available) return null;
    try {
      return await this.backend.workspaceAuthorize(path);
    } catch (err) {
      logger.warn('app', '工作区授权失败', { err: String(err) });
      return null;
    }
  }

  /**
   * 撤销工作区授权（W5.5）。
   */
  async revokeWorkspace(): Promise<{ authorized: boolean } | null> {
    if (!this.backend?.available) return null;
    try {
      return await this.backend.workspaceRevoke();
    } catch (err) {
      logger.warn('app', '撤销工作区授权失败', { err: String(err) });
      return null;
    }
  }

  /**
   * 授权挂载点清单（文件沙箱根集合；devOnly 高级能力）。
   */
  async listMounts(): Promise<string[]> {
    if (!this.backend?.available) return [];
    try {
      return await this.backend.mountList();
    } catch (err) {
      logger.warn('app', '获取挂载点清单失败', { err: String(err) });
      return [];
    }
  }

  /**
   * 目录加入授权挂载点（文件沙箱根；devOnly 高级能力）。
   */
  async authorizeMount(path: string): Promise<string[] | null> {
    if (!this.backend?.available) return null;
    try {
      return await this.backend.mountAuthorize(path);
    } catch (err) {
      logger.warn('app', '挂载授权失败', { path, err: String(err) });
      return null;
    }
  }

  /**
    * 获取 knowledgeGraph 拓扑（用于视图初始化）。
    * 当前后端仅暴露单一 knowledge_graph 接口；五元 inspect 快照
    * 尚无独立 op，回传节点/边拓扑供视图消费。
    */
  async getKnowledgeGraph(): Promise<KnowledgeGraphResult | null> {
    if (!this.backend?.available) return null;
    try {
      return await this.backend.knowledgeGraph();
    } catch {
      return null;
    }
  }

  /**
   * 引擎就绪检查。
   */
  async isEngineReady(): Promise<boolean> {
    const status = await this.getStatus();
    const ready = status?.engine_ready ?? false;
    if (!ready) {
      logger.warn('app', '引擎未就绪', { available: Boolean(this.backend?.available), status: String(status ?? '') });
    }
    return ready;
  }

  /**
   * 创建 ChannelHub（用于视图绑定消费）。
   */
  createChannelHub(): ChannelHub {
    return new ChannelHub();
  }

  /**
   * 分发事件到 ChannelHub（用于测试/夹具）。
   */
  dispatchEvent(event: HubEvent): void {
    if (this.hub) {
      this.hub.dispatch(event);
    }
  }

  /**
   * 是否为事件类型（校验助手）。
   */
  isEventTypeName(name: string): boolean {
    return isEventTypeName(name);
  }
}

/** 便捷工厂：创建 AppBackend 实例。 */
export function createAppBackend(options: AppBackendOptions = {}): AppBackend {
  return new AppBackend(options);
}

/** 回放当前会话状态（用于视图初始化）。 */
export function getSessionSnapshot(hub: ChannelHub | null): SessionSnapshot | null {
  return hub ? hub.getSnapshot() : null;
}
