/**
 * 声明式工具定义（declarative_tools.py DeclarativeToolSpec 移植）。
 *
 * 工具定义 = 数据：name/description/parameters（JSON Schema）/强制声明
 * 权限/端点类型/端点配置/元数据/定义级网络策略。注册一个新工具 = 声明
 * 一条数据，而非编写执行函数——执行体经执行体注册表按端点类型分发。
 *
 * 安全边界（fail-closed 底线，全部提前到构造/定义期）：
 * - 强制权限声明：permissions 缺失或为空 = 校验失败（未声明权限的工具
 *   默认拒绝是 PermissionGate 的兜底语义，声明式注册把它提前到建表期）；
 * - 权限声明逐条经 parse_permission 校验（非法形态即拒绝）；
 * - 端点类型须已注册（内置或经 EndpointTypeRegistry.register 登记，
 *   未注册 = 构造即拒绝，fail-closed）；
 * - process_exec/file_ops 强制声明 allowlist/root（沙箱守卫白名单，
 *   缺失即拒绝）；file_ops 的 operation enum 须 ⊆ 引擎操作域（防
 *   「file_edit 自诞生起即不可达」类静默缺口——声明与提取器白名单
 *   不一致在定义期暴露而非运行期 fail-closed）。
 *
 * 端点归一：宿主可传字符串形态（"file_ops"）——TS 端内置端点以常量
 * 字符串承载，值比较即恒等比较，字符串形态与常量恒等（构造成功即
 * 运行期可用，无「校验放行但 is 全 False」静默失效）；非内置字符串 =
 * 自定义端点（经注册表校验），保留字符串形态。
 */
import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';
import { ToolSpec } from '../llm/tools.js';
import { parse_permission } from '../permissions/permissions.js';
import { NetworkPolicy } from '../permissions/networkPolicy.js';
import { endpoint_registry } from './endpoint_registry.js';
import { EndpointType } from './endpoint_types.js';

export interface DeclarativeToolSpecInit {
  /** 工具名（全局唯一，重复注册由宿主注册表判定）。 */
  name: string;
  /** 工具描述（LLM 选工具的依据）。 */
  description?: string;
  /** 参数 JSON Schema dict（OpenAI 兼容形态）。 */
  parameters?: Record<string, unknown>;
  /** 声明式权限（强制非空，如 ``filesystem:write:/book/**``）。 */
  permissions?: readonly string[];
  /** 端点类型（内置端点值或自定义注册表名；缺省 http_fetch）。 */
  endpoint?: string;
  /** 端点配置（http_fetch: method/base_url；process_exec: 命令白名单；
   *  file_ops: 操作白名单；mcp: server_id 路由密钥），随定义持久化。 */
  endpoint_config?: Record<string, unknown>;
  /** 扩展元数据（宿主语义，如来源 harness/经验蒸馏标记）。 */
  meta?: Record<string, unknown>;
  /** 定义级网络策略（http_fetch 端点的域名白名单声明；None = 不声明，
   *  走流水线全局策略）。 */
  network_policy?: NetworkPolicy | null;
}

/** Python repr 口径的字符串渲染（错误文案 {endpoint!r} 形态）。 */
function _pyRepr(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (value === null) return 'None';
  return String(value);
}

/**
 * 声明式工具定义（数据形态，构造期即完成全量校验）。
 */
export class DeclarativeToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly permissions: readonly string[];
  /** 端点类型：内置端点 = 内置常量值；自定义端点 = 注册表名（构造期
   *  经 EndpointTypeRegistry 校验，即 fail-closed）。 */
  readonly endpoint: string;
  readonly endpoint_config: Record<string, unknown>;
  readonly meta: Record<string, unknown>;
  readonly network_policy: NetworkPolicy | null;

  constructor(init: DeclarativeToolSpecInit) {
    this.name = init.name;
    this.description = init.description ?? '';
    this.parameters = init.parameters ?? {};
    this.permissions = init.permissions ?? [];
    // 端点归一：内置端点 = 常量字符串（值比较即恒等）；自定义端点保留
    // 字符串形态，两者均构造期经 validate() 的注册表校验 fail-closed
    this.endpoint = String(init.endpoint ?? EndpointType.HTTP_FETCH);
    this.endpoint_config = init.endpoint_config ?? {};
    this.meta = init.meta ?? {};
    this.network_policy = init.network_policy ?? null;
    this.validate();
  }

  /**
   * 定义期校验（fail-fast：权限缺失/权限声明非法/参数 schema 非法/端点
   * 白名单缺失——缺声明即拒绝，不延后到执行期）。命名规范断言不在此层：
   * 工具名规则在提案/自写边界执行，本层承载通用定义形态校验。
   */
  validate(): void {
    if (!this.name) throw new GraphDefinitionError('工具名不能为空');
    if (this.permissions.length === 0) {
      throw new GraphDefinitionError(
        `工具 ${this.name} 必须声明权限（fail-closed：未声明权限的工具默认拒绝）`,
      );
    }
    for (const perm of this.permissions) {
      try {
        parse_permission(perm);
      } catch (exc) {
        const detail = exc instanceof Error ? exc.message : String(exc);
        throw new GraphDefinitionError(`工具 ${this.name} 权限声明非法: ${detail}`);
      }
    }
    if (!isRecord(this.parameters)) {
      throw new GraphDefinitionError(`工具 ${this.name} 参数 schema 须为 JSON Schema dict`);
    }
    const spec = endpoint_registry.get(this.endpoint);
    if (spec === undefined) {
      throw new GraphDefinitionError(
        `工具 ${this.name} 端点类型未注册: ${_pyRepr(this.endpoint)}` +
          '（须为内置端点或经 EndpointTypeRegistry.register 注册的自定义端点）',
      );
    }
    for (const key of spec.config_requirements) {
      if (!this.endpoint_config[key]) {
        throw new GraphDefinitionError(
          `工具 ${this.name} 的 ${this.endpoint} 端点须声明 ${key}（沙箱守卫白名单，缺失即拒绝）`,
        );
      }
    }
    if (this.endpoint === EndpointType.PROCESS_EXEC) {
      const allowlist = this.endpoint_config['allowlist'];
      if (
        !Array.isArray(allowlist) ||
        allowlist.length === 0 ||
        !allowlist.every((cmd) => typeof cmd === 'string' && Boolean(cmd))
      ) {
        throw new GraphDefinitionError(`工具 ${this.name} 的 allowlist 须为非空命令白名单清单`);
      }
    }
    if (this.endpoint === EndpointType.FILE_OPS) {
      const root = this.endpoint_config['root'];
      if (typeof root !== 'string' || !root) {
        throw new GraphDefinitionError(`工具 ${this.name} 的 root 须为非空根目录路径`);
      }
      // 定义期硬校验：parameters 声明的 operation enum 必须全部落在引擎
      // 操作域内（防「file_edit 自诞生起即不可达」类静默缺口）
      const opEnum = this._declared_operation_enum();
      const allowed = new Set(spec.actions);
      const unsupported = [...opEnum].filter((op) => !allowed.has(op));
      if (unsupported.length > 0) {
        throw new GraphDefinitionError(
          `工具 ${this.name} 声明了引擎不支持的文件操作: ${unsupported.sort().join('、')}` +
            `（合法值：${[...allowed].sort().join('、')}）`,
        );
      }
    }
  }

  /** 参数 schema 中声明的 operation 枚举值（缺声明 = 空集）。 */
  _declared_operation_enum(): Set<string> {
    const props = this.parameters['properties'];
    if (!isRecord(props)) return new Set();
    const opSchema = props['operation'];
    if (!isRecord(opSchema)) return new Set();
    const enumRaw = opSchema['enum'];
    if (!Array.isArray(enumRaw)) return new Set();
    return new Set(enumRaw.filter((item): item is string => typeof item === 'string'));
  }

  /** 转为引擎工具描述（参数 schema 与权限声明透传）。 */
  to_spec(): ToolSpec {
    return new ToolSpec({
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      permissions: [...this.permissions],
    });
  }

  /** 序列化为数据形态（工具 = 数据：可入 checkpoint/知识集/仓库）。 */
  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      permissions: [...this.permissions],
      endpoint: this.endpoint,
      endpoint_config: this.endpoint_config,
      meta: this.meta,
    };
    if (this.network_policy !== null) {
      data['network_policy'] = {
        allow_domains: [...new Set(this.network_policy.allow_domains)].sort(),
      };
    }
    return data;
  }

  /** 从数据形态还原（构造期校验兜底；未知键忽略，兼容增量演进）。 */
  static from_dict(data: Record<string, unknown>): DeclarativeToolSpec {
    const rawEndpoint = data['endpoint'] ?? EndpointType.HTTP_FETCH;
    const endpoint = String(rawEndpoint);
    let network_policy: NetworkPolicy | null = null;
    const rawPolicy = data['network_policy'];
    if (rawPolicy !== null && rawPolicy !== undefined) {
      if (!isRecord(rawPolicy)) {
        throw new GraphDefinitionError('network_policy 声明须为 dict');
      }
      const domains = rawPolicy['allow_domains'];
      if (
        !Array.isArray(domains) ||
        domains.length === 0 ||
        !domains.every((domain) => typeof domain === 'string' && Boolean(domain))
      ) {
        throw new GraphDefinitionError('network_policy.allow_domains 须为非空域名白名单清单');
      }
      network_policy = new NetworkPolicy([...(domains as string[])]);
    }
    const permissionsRaw = data['permissions'];
    const permissions = Array.isArray(permissionsRaw)
      ? (permissionsRaw as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
    return new DeclarativeToolSpec({
      name: data['name'] as string,
      description: (data['description'] as string | undefined) ?? '',
      parameters: isRecord(data['parameters']) ? data['parameters'] : {},
      permissions,
      endpoint,
      endpoint_config: isRecord(data['endpoint_config']) ? data['endpoint_config'] : {},
      meta: isRecord(data['meta']) ? data['meta'] : {},
      network_policy,
    });
  }
}
