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
import { setUiComponentsDisabled } from '@/renderer/componentRegistry';
import { logger } from '@/shared/logger';
import { ChannelHub, type SessionSnapshot, type HubEvent } from '@/shared/session/channelHub';
import { isEventTypeName } from '@/shared/session/eventTypes';
import type { UISpec } from '@/renderer/uiSpecTypes';

import { isFixtureMode } from './wiring/env';

import type { McpMarketEntry, ToolDetail, AppArtifactEntry } from './types';
import type {
  McpMarketSummary,
  McpMountOutcome,
  McpMountStatus,
  McpMarketPreview,
  ToolManifestEntry,
} from '@/shared/backend/backendAdapter';

import mcpMarketSeed from '../../../seed_data/mcp_market.json';
import toolsSeed from '../../../seed_data/tools.json';
import uiSpecSeed from '../../../seed_data/ui_spec.json';
import productManifest from '../../../manifest.json';

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

  /** 全量工具清单（设置页「工具」管理面）：引擎真实数据 + 常驻必带标记。
   *
   * 与 getToolsSnapshot 分工：快照 = 常驻必带集口径（自动审批勾选项）；
   * 本方法 = merged_specs 全部工具（含 MCP 挂载），附来源/端点/mcp_server
   * 归属与 baseline 标记，供工具管理界面展示与勾选。
   */
  async getToolsManifest(): Promise<{ tools: ToolManifestEntry[]; baseline: string[] }> {
    if (this.backend?.available) {
      try {
        return await this.backend.toolsManifest();
      } catch (err) {
        logger.warn('app', '获取工具清单失败', { err: String(err) });
      }
    }
    return isFixtureMode() ? fixtureToolsManifest() : { tools: [], baseline: [] };
  }

  /** 常驻必带工具集读取（设置页勾选态；宿主不可用回落出厂基线）。 */
  async getToolBaseline(): Promise<string[]> {
    if (this.backend?.available) {
      try {
        const result = await this.backend.toolsBaselineGet();
        return result.tools ?? [];
      } catch (err) {
        logger.warn('app', '获取常驻必带工具失败', { err: String(err) });
      }
    }
    return isFixtureMode() ? fixtureToolsManifest().baseline : [];
  }

  /** 常驻必带工具集写入（整集替换；非法名结构化拒绝）。 */
  async setToolBaseline(tools: string[]): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
    if (!this.backend?.available) {
      logger.info('app', '常驻必带工具设置（dev 回退）', { tools });
      return { ok: true, tools };
    }
    try {
      const result = await this.backend.toolsBaselineSet(tools);
      return { ok: true, tools: result.tools ?? [] };
    } catch (err) {
      logger.warn('app', '常驻必带工具设置失败', { err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /** 能力记录读取（权限矩阵数据面：自动审批勾选 + 档位覆盖 + 回合工具上限）。 */
  async getCapability(): Promise<{
    autoApproveTools: string[];
    autoApproveAllReview: boolean;
    tierOverrides: Record<string, string>;
    maxToolRounds?: number;
  }> {
    if (!this.backend?.available) {
      return { autoApproveTools: [], autoApproveAllReview: false, tierOverrides: {} };
    }
    try {
      const cap = await this.backend.capabilityGet();
      return {
        autoApproveTools: Array.isArray(cap.auto_approve_tools) ? cap.auto_approve_tools : [],
        autoApproveAllReview: cap.auto_approve_all_review === true,
        tierOverrides: cap.tier_overrides && typeof cap.tier_overrides === 'object' ? (cap.tier_overrides as Record<string, string>) : {},
        maxToolRounds: typeof cap.max_tool_rounds === 'number' ? cap.max_tool_rounds : undefined,
      };
    } catch (err) {
      logger.warn('app', '读取能力记录失败', { err: String(err) });
      return { autoApproveTools: [], autoApproveAllReview: false, tierOverrides: {} };
    }
  }

  /** 回合工具上限写入（执行参数：llm_decider 单回合工具调用护栏）。 */
  async setMaxToolRounds(rounds: number): Promise<{ ok: boolean; error?: string }> {
    if (!this.backend?.available) {
      logger.info('app', '回合工具上限设置（dev 回退）', { rounds });
      return { ok: true };
    }
    try {
      await this.backend.capabilityPut({ max_tool_rounds: rounds });
      return { ok: true };
    } catch (err) {
      logger.warn('app', '回合工具上限设置失败', { err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /** 逐工具档位覆盖写入（权限矩阵写面；deny 出厂档/非法值安全域硬拒）。 */
  async setTierOverrides(overrides: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    if (!this.backend?.available) {
      logger.info('app', '档位覆盖设置（dev 回退）', { overrides });
      return { ok: true };
    }
    try {
      await this.backend.securityTierOverridesSet(overrides);
      return { ok: true };
    } catch (err) {
      logger.warn('app', '档位覆盖设置失败', { err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /** 自动审批写入（用户预授权：只读感知/测试构建类工具；边界外安全域硬拒）。 */
  async setAutoApprove(tools: string[], allReview: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.backend?.available) {
      logger.info('app', '自动审批设置（dev 回退）', { tools, allReview });
      return { ok: true };
    }
    try {
      await this.backend.capabilityPut({ auto_approve_tools: tools, auto_approve_all_review: allReview });
      return { ok: true };
    } catch (err) {
      logger.warn('app', '自动审批设置失败', { err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /** MCP 市场数据：宿主优先（多市场状态），宿主不可用回落种子夹具。 */
  async getMcpMarket(): Promise<McpMarketEntry[]> {
    if (this.backend?.available) {
      try {
        const status = await this.backend.mcpMarketStatus();
        const entries = status.markets.flatMap((m) => m.servers);
        if (entries.length > 0) return entries;
      } catch (err) {
        logger.warn('app', '获取 MCP 市场失败', { err: String(err) });
      }
    }
    if (!isFixtureMode()) return [];
    return (mcpMarketSeed as { servers?: unknown[] }).servers?.map((s) => s as unknown as McpMarketEntry) ?? [];
  }

  /** MCP 市场 + 挂载状态（连接页市场管理 / 市场页数据源）。 */
  async getMcpMarketStatus(): Promise<McpMountStatus> {
    if (!this.backend?.available) {
      const seed = isFixtureMode()
        ? (mcpMarketSeed as unknown as { servers?: McpMarketEntry[] }).servers ?? []
        : [];
      return {
        markets: [
          {
            id: 'market',
            name: '内置市场',
            source: '',
            builtin: true,
            servers: seed,
          },
        ],
        mounted: {},
      };
    }
    try {
      return await this.backend.mcpMarketStatus();
    } catch (err) {
      logger.warn('app', '获取 MCP 挂载状态失败', { err: String(err) });
      return { markets: [], mounted: {} };
    }
  }

  /** 市场一键挂载（手动挂载：免审批卡）。 */
  async mountMcp(serverId: string): Promise<McpMountOutcome> {
    if (!this.backend?.available) {
      logger.info('app', 'MCP 挂载（dev 回退）', { serverId });
      return { ok: true, server_id: serverId, status: 'mounted' };
    }
    try {
      return await this.backend.mcpMarketMount(serverId);
    } catch (err) {
      logger.warn('app', 'MCP 挂载失败', { serverId, err: String(err) });
      return { ok: false, server_id: serverId, status: 'mount_failed', error: String(err) };
    }
  }

  /** 市场服务取消挂载。 */
  async unmountMcp(serverId: string): Promise<McpMountOutcome> {
    if (!this.backend?.available) {
      logger.info('app', 'MCP 卸载（dev 回退）', { serverId });
      return { ok: true, server_id: serverId, status: 'unmounted' };
    }
    try {
      return await this.backend.mcpMarketUnmount(serverId);
    } catch (err) {
      logger.warn('app', 'MCP 卸载失败', { serverId, err: String(err) });
      return { ok: false, server_id: serverId, status: 'unmount_failed', error: String(err) };
    }
  }

  /** 市场摄入预览（vetting + 摘要）。 */
  async previewMarket(link: string): Promise<McpMarketPreview> {
    if (!this.backend?.available) {
      return { ok: false, error: '宿主不可用（预览需真实引擎）' };
    }
    try {
      return await this.backend.mcpMarketPreview(link);
    } catch (err) {
      logger.warn('app', 'MCP 市场预览失败', { link, err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /** 添加市场（外部目录摄入，落注册表持久化）。 */
  async addMarket(link: string): Promise<{ ok: boolean; market?: McpMarketSummary; error?: string }> {
    if (!this.backend?.available) {
      return { ok: false, error: '宿主不可用（添加市场需真实引擎）' };
    }
    try {
      return await this.backend.mcpMarketAdd(link);
    } catch (err) {
      logger.warn('app', 'MCP 市场添加失败', { link, err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /** 删除市场（内置不可删；级联卸载其下服务）。 */
  async removeMarket(marketId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.backend?.available) {
      return { ok: false, error: '宿主不可用（删除市场需真实引擎）' };
    }
    try {
      const result = await this.backend.mcpMarketRemove(marketId);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      logger.warn('app', 'MCP 市场删除失败', { marketId, err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /** 已注册/已挂载组件清单：拉取宿主 components_manifest（链为权威）。
   *
   * 与 MCP 市场分离：组件不再是「可挂载市场目录」，而是补丁链产物的
   * 已注册清单（agent 自写 / 外部 URL 组件经 ARTIFACT 补丁落链登记）。
   * 宿主不可用 = 空清单（无夹具回落）。
   */
  async getComponentsManifest(): Promise<AppArtifactEntry[]> {
    if (!this.backend?.available) return [];
    try {
      const manifest = await this.backend.componentsManifest();
      return (manifest.artifacts ?? []) as AppArtifactEntry[];
    } catch (err) {
      logger.warn('app', '获取组件清单失败', { err: String(err) });
      return [];
    }
  }

  /** 出厂界面组件清单（种子 manifest 契约段；组件 tab 合并展示的 factory 源）。 */
  getFactoryComponents(): string[] {
    return (
      (productManifest as { contracts?: { renderer_components?: string[] } }).contracts
        ?.renderer_components ?? []
    );
  }

  /**
   * 出厂界面组件启停状态（组件 tab 数据源）：
   * 宿主经 engine.ui_components_get（factory 权威 = 配方白名单未过滤全集）；
   * 无宿主回落种子 manifest 契约清单（出厂全量、零停用）。
   */
  async getUiComponentsState(): Promise<{ factory: string[]; disabled: string[]; active: string[] }> {
    const factory = this.getFactoryComponents();
    if (!this.backend?.available) {
      return { factory, disabled: [], active: factory };
    }
    try {
      return await this.backend.uiComponentsGet();
    } catch (err) {
      logger.warn('app', '获取出厂组件启停状态失败（回落出厂全量）', { err: String(err) });
      return { factory, disabled: [], active: factory };
    }
  }

  /** 停用/恢复出厂组件（组件 tab 勾选落地面；非法名结构化拒绝）。 */
  async setUiComponentsDisabled(
    disabled: string[],
  ): Promise<{ ok: boolean; disabled?: string[]; error?: string }> {
    if (!this.backend?.available) {
      logger.info('app', '停用出厂组件（dev 回退）', { disabled });
      return { ok: true, disabled };
    }
    try {
      const result = await this.backend.uiComponentsSetDisabled(disabled);
      return { ok: true, disabled: result.disabled ?? [] };
    } catch (err) {
      logger.warn('app', '停用出厂组件失败', { err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /** 出厂组件启停应用到渲染器白名单（停用组件渲染占位拒绝；读取失败保持现状）。 */
  async syncUiComponentGate(): Promise<void> {
    try {
      const state = await this.getUiComponentsState();
      setUiComponentsDisabled(state.disabled);
    } catch (err) {
      logger.warn('app', '出厂组件启停同步渲染白名单失败', { err: String(err) });
    }
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
   * ui_spec 拉取（W4.1）：生产环境经 introspection 活跃界面快照
   * （ui_spec.get —— 与渲染器同一数据源），宿主不可用时回落种子
   * ui_spec.json（dev 夹具）。
   */
  async getUiSpec(): Promise<UISpec | null> {
    if (!this.backend?.available) {
      return isFixtureMode() ? (uiSpecSeed as unknown as UISpec) : null;
    }
    try {
      const result = await this.backend.uiSpecGet();
      return (result?.spec as unknown as UISpec) ?? (isFixtureMode() ? (uiSpecSeed as unknown as UISpec) : null);
    } catch (err) {
      logger.warn('app', '获取 ui_spec 失败', { err: String(err) });
      return isFixtureMode() ? (uiSpecSeed as unknown as UISpec) : null;
    }
  }

  /**
   * ui_spec 保存（W4.2）：经 ui_spec.apply 落补丁链（kind=ui），
   * 活跃界面即时生效 + 可回退；产物到补丁链落链（不再直写能力记录）。
   * 宿主不可用时记录到日志（dev 回退）。
   */
  async saveUiSpec(spec: UISpec): Promise<{ applied: boolean }> {
    if (!this.backend?.available) {
      logger.info('app', 'ui_spec 保存（dev 回退）', { version: spec.version, name: spec.name });
      return { applied: true };
    }
    try {
      const result = await this.backend.uiSpecApply(spec as unknown as Record<string, unknown>);
      const outcome = (result?.outcome ?? {}) as { applied?: boolean; decision?: string; status?: string };
      const applied = outcome.applied === true || outcome.decision === 'accept' || outcome.status === 'applied';
      return { applied };
    } catch (err) {
      logger.warn('app', '保存 ui_spec 失败', { err: String(err) });
      return { applied: false };
    }
  }

  /**
   * ui_spec 回退（W4.2）：回退最近一笔界面补丁（补丁链级，非整库快照）。
   * 宿主不可用时 dev 回退（成功）。
   */
  async revertUiSpec(): Promise<{ reverted: boolean; chain_version?: number }> {
    if (!this.backend?.available) {
      logger.info('app', 'ui_spec 回退（dev 回退）');
      return { reverted: true, chain_version: 0 };
    }
    try {
      const result = await this.backend.uiSpecRevert();
      const outcome = (result?.outcome ?? {}) as {
        applied?: boolean;
        decision?: string;
        status?: string;
        patch_id?: number;
      };
      if (!outcome || outcome.status === 'rejected' || outcome.decision === 'reject') {
        logger.warn('app', '回退 ui_spec 未生效', { reason: result?.reason ?? '未知原因' });
        return { reverted: false };
      }
      const chain_version = outcome.patch_id !== undefined ? Math.max(0, outcome.patch_id - 1) : undefined;
      return { reverted: true, ...(chain_version !== undefined ? { chain_version } : {}) };
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
   * 授权挂载点清单（文件沙箱根集合）。
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
   * 目录加入授权挂载点（文件沙箱根）。
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
   * 系统原生目录选择器（工作区/挂载授权共用；宿主不可用 = null）。
   */
  async openDirectoryDialog(options: { title: string; directory: boolean; multiple: boolean }): Promise<string[] | null> {
    if (!this.backend?.available) return null;
    try {
      return await this.backend.openDirectoryDialog(options);
    } catch (err) {
      logger.warn('app', '目录选择器调用失败', { err: String(err) });
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

/** 出厂常驻必带工具集（与引擎 BASELINE_TOOL_NAMES 同源；dev 夹具口径）。 */
const FACTORY_BASELINE = [
  'file_read', 'file_write', 'file_edit', 'grep', 'glob',
  'propose_patch', 'propose_domain_manifest', 'inspect_tools',
  'search_tools', 'request_tool', 'task_manager',
] as const;

/** dev 夹具：从种子 tools.json 构建全量工具清单（无宿主时视图可渲染）。 */
function fixtureToolsManifest(): { tools: ToolManifestEntry[]; baseline: string[] } {
  const seedTools = (toolsSeed as { tools?: Array<Record<string, unknown>> }).tools ?? [];
  const tools: ToolManifestEntry[] = seedTools.map((t) => ({
    name: t.name as string,
    description: (t.description as string) ?? '',
    parameters: (t.parameters as Record<string, unknown>) ?? {},
    permissions: (t.permissions as string[]) ?? [],
    source: 'declarative',
    endpoint: (t.endpoint as string) ?? 'mcp',
    endpoint_config: (t.endpoint_config as Record<string, unknown>) ?? {},
    meta: (t.meta as ToolManifestEntry['meta']) ?? {},
    approval: (t.approval as string) ?? 'review',
    baseline: false,
  }));
  for (const name of ['search_tools', 'request_tool'] as const) {
    tools.push({
      name,
      description:
        name === 'search_tools'
          ? '语义检索未常驻工具并按相关度返回候选清单。'
          : '绑定检索命中的工具到本回合，注入完整 schema 后按参调用。',
      parameters: {},
      source: 'self',
      baseline: true,
    });
  }
  const present = new Set(tools.map((t) => t.name));
  const baseline: string[] = FACTORY_BASELINE.filter((n) => present.has(n));
  for (const tool of tools) {
    if (baseline.includes(tool.name)) tool.baseline = true;
  }
  return { tools, baseline };
}

/** 回放当前会话状态（用于视图初始化）。 */
export function getSessionSnapshot(hub: ChannelHub | null): SessionSnapshot | null {
  return hub ? hub.getSnapshot() : null;
}
