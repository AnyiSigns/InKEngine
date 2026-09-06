// gate: 超限(415 行) - App 视图层后端封装（BackendAdapter 方法与种子夹具回落同一面成对维护）
/**
 * App 视图层后端封装：面向各视图提供类型化的后端访问接口。
 *
 * 职责：
 * - 工具面板：tools.full（全量视图 + baseline/approved/enabled 消费旗标）、
 *   capability.*（auto 审批/档位登记/回合上限）、ui_components 启停；
 * - MCP 市场：mcp.market/mount/unmount（seed 单源；preview/add/remove 无真源）；
 * - 工作区授权：workspace.state/set/revoke + mount.add + 原生目录选择；
 * - 界面编辑器（W2 前）：ui_spec.* 无真源，仅 dev 夹具承载（生产标注开发模式）。
 *
 * 宿主不可用（浏览器 dev / 无壳）时回落到种子数据夹具：视图仍可渲染，
 * 仅挂载/授权类操作在无宿主时降级为本地状态记录。
 */

import { createBackend, type BackendAdapter, type ToolFullView, type McpMarketData } from '@/shared/backend/backendAdapter';
import { setUiComponentsDisabled } from '@/renderer/componentRegistry';
import { logger } from '@/shared/logger';
import type { UISpec } from '@/renderer/uiSpecTypes';

import { isFixtureMode } from './wiring/env';

import type { McpMountOutcome } from '@/shared/backend/backendAdapter';

import mcpMarketSeed from '../../../seed_data/mcp_market.json';
import toolsSeed from '../../../seed_data/tools.json';
import uiSpecSeed from '../../../seed_data/ui_spec.json';
// 双项目并存期身份 manifest 真源在旧侧 inkling/（import 路径即真源位）；旧侧停用后统一收口。
import productManifest from '../../../../inkling/manifest.json';

export interface AppBackendOptions {
  backend?: BackendAdapter | null;
}

/**
 * App 视图层后端服务：封装 BackendAdapter + 种子数据夹具。
 * 生产环境走宿主桥；浏览器 dev 回退种子数据。
 */
export class AppBackend {
  private backend: BackendAdapter | null;
  public readonly available: boolean;
  constructor(options: AppBackendOptions = {}) {
    this.backend = options.backend ?? createBackend();
    this.available = this.backend?.available ?? false;
  }

  /** 全量工具视图（设置页「工具」管理面）：tools.full 消费旗标同源。
   *
   * baseline/approved/enabled 均为引擎运行态消费旗标；无宿主（fixture
   * 模式）时由种子 tools.json 合成 name-only 行（旗标缺省全 false）。
   */
  async getToolsManifest(): Promise<ToolFullView> {
    if (this.backend?.available) {
      try {
        return await this.backend.toolsManifest();
      } catch (err) {
        logger.warn('app', '获取工具清单失败', { err: String(err) });
      }
    }
    return isFixtureMode() ? fixtureToolsFull() : { uses_vectors: false, tools: [] };
  }

  /** 常驻必带工具集读取（capability.baseline.get；宿主不可用回落空集）。 */
  async getToolBaseline(): Promise<string[]> {
    if (this.backend?.available) {
      try {
        const result = await this.backend.toolsBaselineGet();
        return result.tools ?? [];
      } catch (err) {
        logger.warn('app', '获取常驻必带工具失败', { err: String(err) });
      }
    }
    return isFixtureMode() ? fixtureBaselineNames() : [];
  }

  /** 常驻必带工具集写入（capability.baseline.set 整集替换；白名单校验失败 = ok:false）。 */
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

  /** 能力记录读取（capability.get：auto 审批勾选 + 档位覆盖 + 回合工具上限）。 */
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

  /** 回合工具上限写入（capability.put max_tool_rounds）。 */
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

  /** 逐工具档位覆盖写入（capability.tier.set 登记面；白名单值 allow/review）。 */
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

  /** 自动审批写入（capability.put：auto_approve_tools + auto_approve_all_review）。 */
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

  /** MCP 市场数据（mcp.market 单源 + mounted 连接态；宿主不可用回落种子夹具）。 */
  async getMcpMarket(): Promise<McpMarketData> {
    if (this.backend?.available) {
      try {
        return await this.backend.mcpMarketStatus();
      } catch (err) {
        logger.warn('app', '获取 MCP 市场失败', { err: String(err) });
      }
    }
    if (!isFixtureMode()) {
      return { source: '', premounted: false, mount_policy: {}, servers: [] };
    }
    const seed = (mcpMarketSeed as { servers?: unknown[] }).servers ?? [];
    return {
      source: '',
      premounted: (mcpMarketSeed as { premounted?: boolean }).premounted === true,
      mount_policy: {},
      servers: seed.map((s) => {
        const row = s as Record<string, unknown>;
        return {
          id: String(row['id'] ?? ''),
          name: String(row['name'] ?? row['id'] ?? ''),
          source: String(row['source'] ?? ''),
          transport: String(row['transport'] ?? ''),
          url: typeof row['url'] === 'string' ? row['url'] : null,
          command: typeof row['command'] === 'string' ? row['command'] : null,
          args: Array.isArray(row['args']) ? (row['args'] as unknown[]).filter((a): a is string => typeof a === 'string') : [],
          risk: typeof row['risk'] === 'string' ? row['risk'] : undefined,
          risk_note: typeof row['risk_note'] === 'string' ? row['risk_note'] : undefined,
          category: typeof row['category'] === 'string' ? row['category'] : undefined,
          credentials: { required: false, note: '' },
          mounted: false,
        };
      }),
    };
  }

  /** 市场服务挂载（mcp.mount：config 由条目 + 用户 command/url 覆盖组成）。 */
  async mountMcp(server: {
    id: string;
    transport?: string;
    command?: string | null;
    url?: string | null;
    args?: string[];
  }): Promise<McpMountOutcome> {
    if (!this.backend?.available) {
      logger.info('app', 'MCP 挂载（dev 回退）', { serverId: server.id });
      return { ok: true, server_id: server.id, status: 'mounted' };
    }
    try {
      return await this.backend.mcpMarketMount(server);
    } catch (err) {
      logger.warn('app', 'MCP 挂载失败', { serverId: server.id, err: String(err) });
      return { ok: false, server_id: server.id, status: 'mount_failed', error: String(err) };
    }
  }

  /** 市场服务取消挂载（mcp.unmount）。 */
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

  /** 出厂界面组件清单（种子 manifest 契约段；组件 tab 合并展示的 factory 源）。 */
  getFactoryComponents(): string[] {
    return (
      (productManifest as { contracts?: { renderer_components?: string[] } }).contracts
        ?.renderer_components ?? []
    );
  }

  /**
   * 出厂界面组件启停状态（ui_components.get）：factory 权威 = 配方白名单
   * 未过滤全集；无宿主回落种子 manifest 契约清单（出厂全量、零停用）。
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

  /** 停用/恢复出厂组件（ui_components.set_disabled 整集替换）。 */
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

  /** ui_spec 拉取（W2 前开发模式）：ui_spec.* 无真源，仅 dev 夹具承载。
   *  宿主可用（生产）时返回 null + 开发模式标注（由 UI 呈现，不发命令）。 */
  async getUiSpec(): Promise<UISpec | null> {
    if (this.backend?.available) return null;
    return isFixtureMode() ? (uiSpecSeed as unknown as UISpec) : null;
  }

  /** ui_spec 保存（W2 前开发模式）：无真源不落链，仅返回未应用。 */
  async saveUiSpec(_spec: UISpec): Promise<{ applied: boolean }> {
    logger.info('app', 'ui_spec 保存未接线（ui_spec.* 无真源，W2 处理）');
    return { applied: false };
  }

  /** ui_spec 回退（W2 前开发模式）：无真源不落链，仅返回未回退。 */
  async revertUiSpec(): Promise<{ reverted: boolean; chain_version?: number }> {
    logger.info('app', 'ui_spec 回退未接线（ui_spec.* 无真源，W2 处理）');
    return { reverted: false };
  }

  /**
   * 工作区授权状态（workspace.state）。
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
   * 工作区授权（workspace.set）。
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
   * 撤销工作区授权（workspace.revoke）。
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
}

/** 便捷工厂：创建 AppBackend 实例。 */
export function createAppBackend(options: AppBackendOptions = {}): AppBackend {
  return new AppBackend(options);
}

const FACTORY_BASELINE = [
  'file_read', 'file_write', 'file_edit', 'grep', 'glob',
  'propose_patch', 'propose_domain_manifest', 'inspect_tools',
  'search_tools', 'request_tool', 'task_manager',
] as const;

/** dev 夹具：常驻必带集（种子工具名须在清单中才计入）。 */
function fixtureBaselineNames(): string[] {
  const present = new Set(
    ((toolsSeed as { tools?: Array<Record<string, unknown>> }).tools ?? []).map((t) => t.name),
  );
  return FACTORY_BASELINE.filter((name) => present.has(name));
}

/** dev 夹具：从种子 tools.json 合成 tools.full 视图（name-only 消费旗标）。 */
function fixtureToolsFull(): ToolFullView {
  const baseline = new Set(fixtureBaselineNames());
  const rows = ((toolsSeed as { tools?: Array<Record<string, unknown>> }).tools ?? [])
    .map((t) => t.name)
    .filter((name): name is string => typeof name === 'string')
    .map((name) => ({
      name,
      uses_vectors: false,
      vector: false,
      baseline: baseline.has(name),
      approved: false,
      enabled: true,
    }));
  for (const name of ['search_tools', 'request_tool'] as const) {
    rows.push({
      name,
      uses_vectors: false,
      vector: false,
      baseline: true,
      approved: false,
      enabled: true,
    });
  }
  return { uses_vectors: false, tools: rows };
}
