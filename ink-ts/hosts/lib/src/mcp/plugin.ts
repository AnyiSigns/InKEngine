/**
 * MCP 工具型插件装载服务（B5：市场命令面退役后的 plugin 启停语义）。
 * // gate: 超限(457 行) - 装载生命周期（候选解析/归属守卫/启停/台账/拉起）单文件保持整链可读
 *
 * 决策（permission_plugin_convergence B5）：MCP 服务端 = 工具型插件——启用 =
 * 会话内装载（connect → import_tools → 声明式注册 + 工具索引刷新），停用 =
 * 注销 + 断开会话（进程回收）。启用集持久化走 host 台账（capability.json
 * `mcp_plugins_enabled`），重启自动拉起（fail-closed：连接失败只记状态不
 * 击穿 boot）。
 *
 * 工具可见性（决策）：注册表可见 + 请求即绑——启用后工具进声明式定义表与
 * 工具索引（search_tools 可检索、request_tool 可绑），不进常驻注入集；停用
 * 即从定义表与索引摘除。
 *
 * 只做装载接线，不复制机制语义：vetting/审批/审计/回退归既有引擎管线
 * （本服务启用的是 plugins 真源已就位的候选 server，装入即声明式工具，
 * 调用走统一流水线门禁）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  McpClientManager,
  McpServerConfig,
  type DeclarativeToolSpec,
} from '@ink-ts/engine';

import type { CapabilityStore } from '../capability/store.js';

/** 启用集台账键（capability.json；数组 = 已启用 plugin/server id）。 */
export const MCP_PLUGINS_ENABLED_KEY = 'mcp_plugins_enabled';

/** 指定安装（额外连接配置）台账键（capability.json；id → 连接配置）。
 *  运行期登记的外部 server（url/command）持久于此，与 plugins/mcp/<id>/spec.json
 *  内置候选同构装载；不写 plugins 源、不触发生成物变更（B6 受控通道）。 */
export const MCP_PLUGINS_EXTRA_KEY = 'mcp_plugins_extra';

/** 指定安装连接配置（用户/agent 经 review 档安装的外部 server）。 */
export interface McpPluginExtraConfig {
  transport: 'stdio' | 'http';
  name?: string;
  url?: string | null;
  command?: string | null;
  args?: string[];
}

/** 候选声明（plugins/mcp/<id>/spec.json 的 data.server 透传形态）。 */
export interface McpPluginCandidate {
  id: string;
  name: string;
  source: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[];
  risk?: string;
  risk_note?: string;
  category?: string;
}

/** 运行态行（candidate + 启用/连接/工具导入状态）。 */
export interface McpPluginStatus extends McpPluginCandidate {
  enabled: boolean;
  connected: boolean;
  tool_count: number;
  error: string | null;
}

/** 单次启停结果信封（enable 带已导入工具名）。 */
export interface McpPluginOutcome {
  ok: boolean;
  server_id: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  tool_count: number;
  tools?: string[];
  error?: string | null;
}

/** host 侧声明式注册/索引接缝（narrow 型；Runtime 满足）。 */
export interface McpPluginDeclarativeSeam {
  register_definition?(definition: DeclarativeToolSpec): void;
  unregister_definition?(name: string): void;
  /** 定义登记表快照（工具名 → 定义；注册前归属校验用）。 */
  definitions?: Readonly<Record<string, { endpoint_config?: Record<string, unknown> | null }>>;
}

/** host 侧运行时接缝（narrow 型；Runtime 满足）。 */
export interface McpPluginHostSeam {
  harness_registry?: {
    declarative?: McpPluginDeclarativeSeam | null;
  } | null;
  refresh_tool_index?(specs: readonly unknown[]): void;
  remove_tool_index?(name: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 台账读取形态收敛（坏形态丢弃）。 */
function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item !== '');
}

/** 额外连接配置台账读取（坏形态丢弃；transport 仅 stdio/http）。 */
function asExtras(raw: unknown): Record<string, McpPluginExtraConfig> {
  if (!isRecord(raw)) return {};
  const out: Record<string, McpPluginExtraConfig> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (id === '' || !isRecord(value)) continue;
    const transport = value['transport'] === 'stdio' ? 'stdio' : 'http';
    const command = typeof value['command'] === 'string' ? value['command'] : null;
    const url = typeof value['url'] === 'string' ? value['url'] : null;
    if (transport === 'stdio' && (command === null || command === '')) continue;
    if (transport === 'http' && (url === null || url === '')) continue;
    const rawArgs = value['args'];
    out[id] = {
      transport,
      ...(typeof value['name'] === 'string' && value['name'] !== ''
        ? { name: value['name'] }
        : {}),
      url,
      command,
      args: Array.isArray(rawArgs)
        ? rawArgs.filter((a): a is string => typeof a === 'string')
        : [],
    };
  }
  return out;
}

/** 从额外连接配置构建候选（与内置候选同构；目录缺失时 list/candidate 合并）。 */
function extraCandidate(id: string, config: McpPluginExtraConfig): McpPluginCandidate {
  return {
    id,
    name: config.name ?? id,
    source: 'user-installed',
    transport: config.transport,
    url: config.transport === 'http' ? (config.url ?? null) : null,
    command: config.transport === 'stdio' ? (config.command ?? null) : null,
    args: config.args ?? [],
    category: 'extra',
  };
}

/** 从候选声明构建连接配置（plugins 真源；来源分类 UNKNOWN 兜底）。 */
export function configFromCandidate(candidate: McpPluginCandidate): McpServerConfig {
  const transport = candidate.transport === 'stdio' ? 'stdio' : 'http';
  const data: Record<string, unknown> = { id: candidate.id, transport };
  if (transport === 'http') {
    if (candidate.url !== null && candidate.url !== '') data['url'] = candidate.url;
  } else {
    if (candidate.command !== null && candidate.command !== '') data['command'] = candidate.command;
    if (candidate.args.length > 0) data['args'] = [...candidate.args];
  }
  return McpServerConfig.from_dict(data);
}

/** 扫描 plugins/mcp/<id>/spec.json 目录（与生成器同源扫描面）。 */
export function scanMcpPluginSpecs(pluginsRoot: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(join(pluginsRoot, 'mcp'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          readFileSync(join(pluginsRoot, 'mcp', name, 'spec.json'), 'utf8');
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
  return entries;
}

function parseCandidate(pluginsRoot: string, id: string): McpPluginCandidate | null {
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(join(pluginsRoot, 'mcp', id, 'spec.json'), 'utf8'),
    ) as unknown;
  } catch {
    return null;
  }
  const spec = isRecord(raw) ? raw : null;
  const server = spec !== null && isRecord(spec['data']) ? spec['data']['server'] : null;
  if (!isRecord(server) || typeof server['id'] !== 'string') return null;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const nullableText = (v: unknown): string | null =>
    typeof v === 'string' && v !== '' ? v : null;
  const argsRaw = server['args'];
  return {
    id: server['id'] as string,
    name: text(server['name']) || (server['id'] as string),
    source: text(server['source']),
    transport: text(server['transport']) || 'http',
    url: nullableText(server['url']),
    command: nullableText(server['command']),
    args: Array.isArray(argsRaw)
      ? (argsRaw as unknown[]).filter((a): a is string => typeof a === 'string')
      : [],
    ...(typeof server['risk'] === 'string' ? { risk: server['risk'] } : {}),
    ...(typeof server['risk_note'] === 'string' ? { risk_note: server['risk_note'] } : {}),
    ...(typeof server['category'] === 'string' ? { category: server['category'] } : {}),
  };
}

/** 装载服务（每 boot 装配一次；重启自动拉起启用集）。 */
export class McpPluginService {
  readonly pluginsRoot: string;
  readonly host: McpPluginHostSeam;
  readonly manager: McpClientManager;
  readonly store: CapabilityStore | null;
  /** 已声明注册的工具名（server_id → 工具名；disable 摘除依据）。 */
  readonly _declared = new Map<string, Set<string>>();
  /** 本装配期连接失败记录（启停状态查询展示；不阻断 boot）。 */
  readonly _errors = new Map<string, string>();

  constructor(init: {
    pluginsRoot: string;
    host: McpPluginHostSeam;
    manager: McpClientManager;
    store?: CapabilityStore | null;
  }) {
    this.pluginsRoot = init.pluginsRoot;
    this.host = init.host;
    this.manager = init.manager;
    this.store = init.store ?? null;
  }

  /** 台账读启用集（坏形态丢弃）。 */
  private _enabledIds(): string[] {
    const record = (this.store?.get() ?? {}) as Record<string, unknown>;
    const raw = record[MCP_PLUGINS_ENABLED_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === 'string' && id !== '');
  }

  private _persist(enabled: readonly string[]): void {
    if (this.store === null) return;
    this.store.put({ [MCP_PLUGINS_ENABLED_KEY]: [...enabled].sort() });
  }

  /** 额外连接配置台账读（坏形态丢弃）。 */
  private _extras(): Record<string, McpPluginExtraConfig> {
    const record = (this.store?.get() ?? {}) as Record<string, unknown>;
    return asExtras(record[MCP_PLUGINS_EXTRA_KEY]);
  }

  private _persistExtra(extras: Record<string, McpPluginExtraConfig>): void {
    if (this.store === null) return;
    this.store.put({ [MCP_PLUGINS_EXTRA_KEY]: extras });
  }

  private _declarative(): McpPluginDeclarativeSeam | null {
    const declarative = this.host.harness_registry?.declarative;
    return declarative !== null && declarative !== undefined ? declarative : null;
  }

  /** 工具名的当前归属 server（定义登记表 endpoint_config.server_id；宿主/其它
   *  声明式工具（无 server_id）= null——同样视为不可被 MCP 覆盖的来源）。 */
  private _ownerOf(name: string): string | null {
    const declarative = this._declarative();
    const definition = declarative?.definitions?.[name];
    if (definition === undefined || definition === null) return null;
    const config = definition.endpoint_config;
    const serverId =
      config !== null && config !== undefined && typeof config['server_id'] === 'string'
        ? config['server_id']
        : null;
    return serverId;
  }

  /** 其它已启用 server 声明过的工具名集合（disable 索引摘除前查重）。 */
  private _otherOwnedNames(exceptId: string): Set<string> {
    const other = new Set<string>();
    for (const [serverId, names] of this._declared) {
      if (serverId === exceptId) continue;
      for (const name of names) other.add(name);
    }
    return other;
  }

  candidate(id: string): McpPluginCandidate | null {
    const fromDir = parseCandidate(this.pluginsRoot, id);
    if (fromDir !== null) return fromDir;
    const extra = this._extras()[id];
    if (extra === undefined) return null;
    return extraCandidate(id, extra);
  }

  /** 候选清单（目录扫描真源 + 额外连接台账；含运行态 + 台账残影错误行）。 */
  list(): McpPluginStatus[] {
    const enabled = new Set(this._enabledIds());
    const connected = new Set(this.manager.list_servers());
    const rows: McpPluginStatus[] = scanMcpPluginSpecs(this.pluginsRoot).map((id) => {
      const candidate = parseCandidate(this.pluginsRoot, id) ?? {
        id,
        name: id,
        source: '',
        transport: 'http',
        url: null,
        command: null,
        args: [],
      };
      const isEnabled = enabled.has(id);
      const declaredCount = this._declared.get(id)?.size;
      return {
        ...candidate,
        enabled: isEnabled,
        connected: connected.has(id),
        tool_count:
          declaredCount !== undefined
            ? declaredCount
            : connected.has(id)
              ? this.manager.imported_tools(id).size
              : 0,
        error: this._errors.get(id) ?? null,
      };
    });
    const present = new Set(rows.map((row) => row.id));
    // 额外连接（指定安装）：非目录候选也作为行暴露（启用/停用/移除管理面）
    for (const [id, config] of Object.entries(this._extras())) {
      if (present.has(id)) continue;
      const candidate = extraCandidate(id, config);
      const isEnabled = enabled.has(id);
      const declaredCount = this._declared.get(id)?.size;
      rows.push({
        ...candidate,
        enabled: isEnabled,
        connected: connected.has(id),
        tool_count:
          declaredCount !== undefined
            ? declaredCount
            : connected.has(id)
              ? this.manager.imported_tools(id).size
              : 0,
        error: this._errors.get(id) ?? null,
      });
      present.add(id);
    }
    // 台账残影（候选目录/额外配置均已移除但仍启用）：作为可停用的错误行暴露，
    // 避免幽灵 id 只在台账里且 UI/命令面不可达。
    for (const id of enabled) {
      if (present.has(id)) continue;
      rows.push({
        id,
        name: id,
        source: '',
        transport: '',
        url: null,
        command: null,
        args: [],
        enabled: true,
        connected: false,
        tool_count: 0,
        error: '候选已移除（目录/额外配置均不存在），停用以清理台账',
      });
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }

  /** 指定安装（B6）：登记额外连接配置并立即启用。
   *
   * 入口默认 review（弹卡/pose 决）：批准后装载与内置候选同构（connect →
   * 导入 → 归属校验 → 注册 → 索引刷新 → 启用台账）。id 不得与内置候选冲突，
   * stdio 须带 command、http 须带 url。 */
  async install(
    id: string,
    config: { transport: 'stdio' | 'http'; name?: string; url?: string | null; command?: string | null; args?: string[] },
  ): Promise<McpPluginOutcome> {
    if (id === '') {
      return { ok: false, server_id: id, transport: '', enabled: false, connected: false, tool_count: 0, error: 'server id 不能为空' };
    }
    const transport = config.transport === 'stdio' ? 'stdio' : 'http';
    if (transport === 'stdio' && (config.command === null || config.command === undefined || config.command === '')) {
      return { ok: false, server_id: id, transport, enabled: false, connected: false, tool_count: 0, error: 'stdio 安装需提供 command 启动命令' };
    }
    if (transport === 'http' && (config.url === null || config.url === undefined || config.url === '')) {
      return { ok: false, server_id: id, transport, enabled: false, connected: false, tool_count: 0, error: 'http 安装需提供 url 端点' };
    }
    const inDir = parseCandidate(this.pluginsRoot, id);
    if (inDir !== null) {
      return { ok: false, server_id: id, transport, enabled: false, connected: false, tool_count: 0, error: `id 与内置候选冲突（plugins/mcp/${id}），直接启用即可` };
    }
    const extras = this._extras();
    extras[id] = {
      transport,
      ...(config.name !== undefined && config.name !== '' ? { name: config.name } : {}),
      url: transport === 'http' ? config.url : null,
      command: transport === 'stdio' ? config.command : null,
      args: Array.isArray(config.args)
        ? config.args.filter((a): a is string => typeof a === 'string')
        : [],
    };
    this._persistExtra(extras);
    return this.enable(id);
  }

  /** 移除指定安装（B6）：停用 + 摘除额外连接配置。 */
  async remove(id: string): Promise<McpPluginOutcome> {
    await this.disable(id);
    const extras = this._extras();
    if (extras[id] !== undefined) {
      delete extras[id];
      this._persistExtra(extras);
    }
    return { ok: true, server_id: id, transport: '', enabled: false, connected: false, tool_count: 0 };
  }

  /** 单服务启停状态（不存在 = null）。 */
  status(id: string): McpPluginStatus | null {
    return this.list().find((row) => row.id === id) ?? null;
  }

  /** 启用：连接（stdio 自动监督拉起）→ 导入 → 归属校验 → 注册 + 索引刷新 → 台账。
   *
   * 幂等：已启用且已连接时短路返回现状（不重连销毁健康会话）；工具名归属冲突
   * （同名定义已被其它 server 或宿主声明式工具持有）整批拒绝，不覆盖他方。
   */
  async enable(id: string): Promise<McpPluginOutcome> {
    const candidate = this.candidate(id);
    if (candidate === null) {
      return { ok: false, server_id: id, transport: '', enabled: false, connected: false, tool_count: 0, error: `候选 server 不存在: ${id}` };
    }
    const connected = this.manager.list_servers().includes(id);
    const enabledNow = new Set(this._enabledIds()).has(id);
    if (connected && enabledNow) {
      const declaredCount = this._declared.get(id)?.size ?? this.manager.imported_tools(id).size;
      return {
        ok: true,
        server_id: id,
        transport: candidate.transport,
        enabled: true,
        connected: true,
        tool_count: declaredCount,
        tools: [...(this._declared.get(id) ?? this.manager.imported_tools(id))],
      };
    }
    const config = configFromCandidate(candidate);
    this._errors.delete(id);
    try {
      await this.manager.connect(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._errors.set(id, message);
      return {
        ok: false,
        server_id: id,
        transport: config.transport,
        enabled: false,
        connected: false,
        tool_count: 0,
        error: `MCP 连接失败: ${message}`,
      };
    }
    let specs: DeclarativeToolSpec[] = [];
    try {
      specs = await this.manager.import_tools(config.id, {
        source: `plugin:${config.id}`,
        vetting: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.manager.disconnect(config.id);
      this._errors.set(id, message);
      return {
        ok: false,
        server_id: id,
        transport: config.transport,
        enabled: false,
        connected: false,
        tool_count: 0,
        error: `MCP 工具导入失败: ${message}`,
      };
    }
    const declarative = this._declarative();
    const names = new Set<string>();
    if (declarative !== null && specs.length > 0) {
      // 归属预检：任何导入名已由其它 server / 宿主声明式工具持有 → 整批拒绝，
      // 防静默覆盖（工具名全局唯一，MCP 协议名不命名空间）。
      const conflicts: string[] = [];
      for (const spec of specs) {
        const owner = this._ownerOf(spec.name);
        if (owner !== null && owner !== id) conflicts.push(spec.name);
      }
      if (conflicts.length > 0) {
        await this.manager.disconnect(config.id);
        this._errors.set(id, `工具名冲突（已被其它来源登记，未导入）: ${conflicts.join(', ')}`);
        return {
          ok: false,
          server_id: id,
          transport: config.transport,
          enabled: false,
          connected: false,
          tool_count: 0,
          error: `工具名冲突（先停用持方或改 server 工具名后再启用）: ${conflicts.join(', ')}`,
        };
      }
      for (const spec of specs) {
        declarative.register_definition?.(spec);
        names.add(spec.name);
      }
      this._declared.set(id, names);
      this.host.refresh_tool_index?.(specs.map((spec) => spec.to_spec()));
    }
    const enabled = new Set(this._enabledIds());
    enabled.add(id);
    this._persist([...enabled]);
    return {
      ok: true,
      server_id: id,
      transport: config.transport,
      enabled: true,
      connected: true,
      tool_count: names.size > 0 ? names.size : specs.length,
      tools: [...names],
    };
  }

  /** 停用：注销本 server 持有的定义 + 索引摘除 + 断开会话（进程回收）→ 台账摘除。
   *
   * 注销按归属收窄：只摘除当前定义仍属于本 server 的工具名；索引条目仅在本
   * server 是唯一声明方时移除（其它启用 server 持有同名 = 不误删）。候选已
   * 缺失但本 server 曾启用/被跟踪 → 清理后返回成功（幂等可清残影）。 */
  async disable(id: string): Promise<McpPluginOutcome> {
    const connectedBefore = this.manager.list_servers().includes(id);
    const enabledIds = this._enabledIds();
    const wasEnabled = enabledIds.includes(id);
    const names = this._declared.get(id) ?? this.manager.imported_tools(id);
    const declarative = this._declarative();
    const otherOwned = this._otherOwnedNames(id);
    if (declarative !== null) {
      for (const name of names) {
        if (this._ownerOf(name) !== id) continue;
        declarative.unregister_definition?.(name);
        if (!otherOwned.has(name)) {
          this.host.remove_tool_index?.(name);
        }
      }
    }
    this._declared.delete(id);
    this._errors.delete(id);
    if (connectedBefore) {
      try {
        await this.manager.disconnect(id);
      } catch {
        // 断开失败不阻断注销（定义已摘除；进程收尾由 close_all 兜底）
      }
    }
    const enabled = new Set(enabledIds);
    enabled.delete(id);
    this._persist([...enabled]);
    if (!wasEnabled && !connectedBefore && names.size === 0 && this.candidate(id) === null) {
      // 从未跟踪的未知 id：无事可做才算失败
      return { ok: false, server_id: id, transport: '', enabled: false, connected: false, tool_count: 0, error: `候选 server 不存在: ${id}` };
    }
    return {
      ok: true,
      server_id: id,
      transport: this.candidate(id)?.transport ?? '',
      enabled: false,
      connected: false,
      tool_count: 0,
    };
  }

  /** 重启自动拉起启用集（boot 装配后调用；失败只记状态不击穿）。
   *
   * 幽灵剪除：候选目录已移除的台账 id 不再重试（磁盘为候选权威），直接清出
   * 台账；真实候选连接失败保留在台账（下次 boot 重试），只记状态。 */
  async restore(): Promise<McpPluginStatus[]> {
    const failures: McpPluginStatus[] = [];
    const ids = this._enabledIds();
    let prune: string[] = [];
    for (const id of ids) {
      if (this.candidate(id) === null) {
        prune = [...prune, id];
        continue;
      }
      const outcome = await this.enable(id);
      if (!outcome.ok) {
        const candidate = this.candidate(id);
        failures.push({
          id,
          name: candidate?.name ?? id,
          source: candidate?.source ?? '',
          transport: candidate?.transport ?? '',
          url: candidate?.url ?? null,
          command: candidate?.command ?? null,
          args: candidate?.args ?? [],
          enabled: true,
          connected: false,
          tool_count: 0,
          error: outcome.error ?? '拉起失败',
        });
      }
    }
    if (prune.length > 0) {
      const enabled = new Set(ids);
      for (const id of prune) enabled.delete(id);
      this._persist([...enabled]);
    }
    return failures;
  }
}
