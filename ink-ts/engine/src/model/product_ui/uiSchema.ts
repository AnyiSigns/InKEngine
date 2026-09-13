/**
 * 界面描述数据原语（产品即数据：布局树/绑定协议/主题 token）——ui_schema.py 移植。
 *
 * 界面描述 = 数据（JSON 布局树），渲染器 = 机制实现（产品侧装配）。
 * AI 经自指层提案界面补丁（ui 补丁类型）落地布局，渲染器消费最新描述即时重渲。
 *
 * 安全边界（JSON 只能描述，不能执行）：
 * - 组件白名单：布局只能引用已注册组件（component.type 必须 ∈ 白名单），
 *   未注册组件 = 校验违规不渲染——杜绝「布局 JSON 执行任意代码」路径；
 * - 绑定白名单：数据绑定只能指向宿主放行的状态通道（bind.channel 必须 ∈
 *   白名单），补丁链/审批/审计等内部通道默认不放行——防信息泄漏；绑定路径
 *   同样受限：保留前缀（_ 开头）的路径段视为内部数据，拒绝绑定；
 * - 主题 token 白名单：布局只能使用已声明的主题键——防任意样式注入。
 *
 * 校验哲学（与 SchemaValidator 同构）：声明式约束 + 违规清单可读可审计；
 * 未知字段忽略（schema 演进宽容），必填缺失 = 违规。绑定协议形态：
 * {"bind": {"channel": "state", "path": "count"}}。
 *
 * 白名单审计：DEFAULT_BIND_CHANNELS = 装配数据化（引擎默认仅 state，宿主
 * 经 AssemblyRecipe.ui_allowed_channels 配方放行扩展通道）；节点类型枚举 /
 * RESERVED_BIND_PREFIXES = 机制固有（布局树语法与内部数据保护语义）。
 *
 * 错误映射：定义期语义违规抛 GraphDefinitionError（装配/定义期 fail-fast）；
 * 校验器本身只返回违规清单不抛错。Python 端 logging 副作用无（纯函数模块）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, type JsonRecord } from '../json.js';

/** 布局节点类型（声明式枚举，防魔法字符串）。 */

import {
  BIND_CHANNEL_KEY,
  BIND_KEY,
  BIND_PATH_KEY,
  DEFAULT_BIND_CHANNELS,
  NODE_KIND_COMPONENT,
  NODE_KIND_CONTAINER,
  RESERVED_BIND_PREFIXES,
  VALID_NODE_KINDS,
  pyInt,
  pyRepr,
  pyTruthy,
  pyTupleRepr,
  tupleHas,
  typeNameOf,
} from './uiSchemaSupport.js';

export {
  BIND_CHANNEL_KEY,
  BIND_KEY,
  BIND_PATH_KEY,
  DEFAULT_BIND_CHANNELS,
  NODE_KIND_COMPONENT,
  NODE_KIND_CONTAINER,
  RESERVED_BIND_PREFIXES,
} from './uiSchemaSupport.js';


export class UIBind {
  readonly channel: string;
  readonly path: string;

  constructor(init: { channel: string; path?: string }) {
    this.channel = init.channel;
    this.path = init.path ?? '';
  }

  to_dict(): Record<string, string> {
    return { [BIND_CHANNEL_KEY]: this.channel, [BIND_PATH_KEY]: this.path };
  }

  static from_dict(data: unknown): UIBind {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`绑定声明非法: 期望 dict，收到 ${typeNameOf(data)}`);
    }
    const channel = data[BIND_CHANNEL_KEY];
    if (!channel || typeof channel !== 'string') {
      throw new GraphDefinitionError('绑定声明缺 channel（字符串）');
    }
    const path = data[BIND_PATH_KEY];
    if (path !== undefined && path !== null && typeof path !== 'string') {
      throw new GraphDefinitionError(`绑定路径非法: ${pyRepr(path)}（须为字符串）`);
    }
    return new UIBind({ channel, path: (path ?? '') as string });
  }
}

/** 布局树节点（container 组织层级，component 引用白名单组件）。 */
export class UINode {
  readonly kind: string;
  readonly type: string;
  readonly props: JsonRecord;
  readonly bind: UIBind | null;
  readonly children: readonly UINode[];

  constructor(init: {
    kind: string;
    type: string;
    props?: JsonRecord;
    bind?: UIBind | null;
    children?: readonly UINode[];
  }) {
    this.kind = init.kind;
    this.type = init.type;
    this.props = { ...(init.props ?? {}) };
    this.bind = init.bind ?? null;
    this.children = [...(init.children ?? [])];
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = { kind: this.kind, type: this.type };
    if (pyTruthy(this.props)) data['props'] = { ...this.props };
    if (this.bind !== null) data[BIND_KEY] = this.bind.to_dict();
    if (this.children.length > 0) {
      data['children'] = this.children.map((child) => child.to_dict());
    }
    return data;
  }

  static from_dict(data: unknown): UINode {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`布局节点非法: 期望 dict，收到 ${typeNameOf(data)}`);
    }
    const kind = data['kind'];
    if (!(VALID_NODE_KINDS as readonly string[]).includes(kind as string)) {
      throw new GraphDefinitionError(
        `布局节点类型非法: ${pyRepr(kind)}（仅 ${pyTupleRepr(VALID_NODE_KINDS)}）`,
      );
    }
    const typeName = data['type'];
    if (!typeName || typeof typeName !== 'string') {
      throw new GraphDefinitionError('布局节点缺 type（字符串）');
    }
    const rawProps = data['props'];
    if (rawProps !== undefined && rawProps !== null && !isRecord(rawProps)) {
      throw new GraphDefinitionError(`节点 ${typeName} 的 props 须为 dict`);
    }
    const rawBind = data[BIND_KEY];
    const bind = rawBind === undefined || rawBind === null ? null : UIBind.from_dict(rawBind);
    let children: readonly UINode[] = [];
    const rawChildren = data['children'];
    if (rawChildren !== undefined && rawChildren !== null) {
      if (!Array.isArray(rawChildren)) {
        throw new GraphDefinitionError(`节点 ${typeName} 的 children 须为清单`);
      }
      children = rawChildren.map((child) => UINode.from_dict(child));
    }
    return new UINode({
      kind: kind as string,
      type: typeName,
      props: (rawProps ?? {}) as JsonRecord,
      bind,
      children,
    });
  }
}

/** 界面描述（布局树 + 主题 token + 版本；纯数据，可序列化随补丁链版本化）。 */
export class UISpec {
  readonly name: string;
  readonly root: UINode | null;
  readonly theme: JsonRecord;
  readonly version: number;

  constructor(init: {
    name: string;
    root?: UINode | null;
    theme?: JsonRecord;
    version?: number;
  }) {
    this.name = init.name;
    this.root = init.root ?? null;
    this.theme = { ...(init.theme ?? {}) };
    this.version = init.version ?? 1;
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = { name: this.name, version: this.version };
    if (this.root !== null) data['root'] = this.root.to_dict();
    if (pyTruthy(this.theme)) data['theme'] = { ...this.theme };
    return data;
  }

  static from_dict(data: unknown): UISpec {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`界面描述非法: 期望 dict，收到 ${typeNameOf(data)}`);
    }
    const name = data['name'];
    if (!name || typeof name !== 'string') {
      throw new GraphDefinitionError('界面描述缺 name（字符串）');
    }
    const rawRoot = data['root'];
    const root = rawRoot === undefined || rawRoot === null ? null : UINode.from_dict(rawRoot);
    const rawTheme = data['theme'];
    if (rawTheme !== undefined && rawTheme !== null && !isRecord(rawTheme)) {
      throw new GraphDefinitionError(`界面 ${name} 的 theme 须为 dict`);
    }
    const version = pyTruthy(data['version']) ? pyInt(data['version']) : 1;
    return new UISpec({
      name,
      root,
      theme: (rawTheme ?? {}) as JsonRecord,
      version,
    });
  }
}

/** 主题键迭代：镜像 Python `for token in theme`（dict 键 / list 元素 / str 字符）。 */
function themeTokens(raw: unknown): unknown[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return [...raw];
  if (isRecord(raw)) return Object.keys(raw);
  if (typeof raw === 'string') return [...raw];
  return [];
}

interface UISchemaValidatorOptions {
  allowed_components?: readonly string[];
  allowed_channels?: readonly string[];
  allowed_theme_tokens?: readonly string[];
}

/** 界面描述校验器（结构 + 三层白名单；纯函数无状态，可作模块级复用）。 */
export class UISchemaValidator {
  /** 校验界面描述 dict（补丁 payload 天然形态）；返回违规清单（空 = 通过）。 */
  validate(data: unknown, options: UISchemaValidatorOptions = {}): string[] {
    const allowed_components = options.allowed_components ?? [];
    const allowed_channels = options.allowed_channels ?? DEFAULT_BIND_CHANNELS;
    const allowed_theme_tokens = options.allowed_theme_tokens ?? [];
    if (!isRecord(data)) {
      return [`界面描述须为 dict，收到 ${typeNameOf(data)}`];
    }
    const violations: string[] = [];
    const root = data['root'];
    if (!isRecord(root)) {
      violations.push('界面描述缺 root（布局树根节点）');
    } else {
      violations.push(...this.validateNode(root, 'root', allowed_components, allowed_channels));
    }
    for (const token of themeTokens(data['theme'])) {
      if (!tupleHas(allowed_theme_tokens, token)) {
        violations.push(
          `theme token 未声明: ${pyRepr(token)}（白名单 ${pyTupleRepr(allowed_theme_tokens)}）`,
        );
      }
    }
    return violations;
  }

  /** 布尔判定便捷入口（零违规 = 通过；闸门组装用）。 */
  validate_ok(data: unknown, options: UISchemaValidatorOptions = {}): boolean {
    return this.validate(data, options).length === 0;
  }

  /** 单节点递归校验（违规带节点路径，可读可审计）。 */
  private validateNode(
    data: JsonRecord,
    path: string,
    allowed_components: readonly string[],
    allowed_channels: readonly string[],
  ): string[] {
    const violations: string[] = [];
    const kind = data['kind'];
    const typeName = data['type'];
    if (kind === NODE_KIND_COMPONENT) {
      if (!tupleHas(allowed_components, typeName)) {
        violations.push(
          `${path}.type 组件未注册: ${pyRepr(typeName)}（白名单 ${pyTupleRepr(allowed_components)}）`,
        );
      }
      if (pyTruthy(data['children'])) {
        violations.push(`${path} component 不允许携带 children`);
      }
    } else if (kind === NODE_KIND_CONTAINER) {
      const children = data['children'];
      if (Array.isArray(children)) {
        children.forEach((child, index) => {
          // Python 端对非 dict 子节点会直接崩溃（未定义输入）；TS 侧宽容跳过
          if (!isRecord(child)) return;
          violations.push(
            ...this.validateNode(
              child,
              `${path}.children[${index}]`,
              allowed_components,
              allowed_channels,
            ),
          );
        });
      }
    } else {
      violations.push(
        `${path}.kind 非法: ${pyRepr(kind)}（仅 ${pyTupleRepr(VALID_NODE_KINDS)}）`,
      );
    }
    const rawBind = data[BIND_KEY];
    if (isRecord(rawBind)) {
      const channel = rawBind[BIND_CHANNEL_KEY];
      if (!tupleHas(allowed_channels, channel)) {
        violations.push(
          `${path}.bind.channel 未放行: ${pyRepr(channel)}（白名单 ${pyTupleRepr(allowed_channels)}）`,
        );
      }
      const bindPath = rawBind[BIND_PATH_KEY];
      if (typeof bindPath === 'string') {
        for (const segment of bindPath.split('.')) {
          if (RESERVED_BIND_PREFIXES.some((prefix) => segment.startsWith(prefix))) {
            violations.push(
              `${path}.bind.path 命中保留前缀: ${pyRepr(bindPath)}（内部数据不可绑定，前缀 ${pyTupleRepr(RESERVED_BIND_PREFIXES)}）`,
            );
            break;
          }
        }
      }
    }
    return violations;
  }
}

/** 界面渲染器接口（机制契约，实现归产品）：消费界面描述产出渲染结果。 */
export interface UIRenderer {
  render(spec: UISpec): unknown;
}
