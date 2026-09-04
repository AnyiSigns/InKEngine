/**
 * 自指层提案协议数据面（core/self_proposal.py 移植：补丁类型声明 + 提案数据形态）。
 *
 * 提案 = AI 修改产品形态的唯一入口形态（观察之后、应用之前）：先把
 * 变更意图整理为声明式补丁（类型 + payload + 基准版本 + 理由），经
 * 按类型校验确认形态合法，再交应用管线走审批分级与落链。本模块只
 * 负责「把提案整理成可校验的数据」——应用、审批、回退在
 * self_application。
 *
 * 补丁类型（演化对象清单的声明式枚举）：界面/主题/工具/规则/知识/
 * harness/事件类型/环境/构建产物/实体——每类复用引擎既有校验器（ui_schema
 * 三层白名单、declarative_tools 定义期校验、rules 规则解析、knowledge_set
 * 条目构造、harness 注册期校验、event_types 声明构造、environments 环境
 * 声明、entities 实体声明），零业务依赖、不发明第二套校验语义。
 *
 * 校验哲学：违规清单可读可审计（闸门失败原因直接展示）；未知字段
 * 忽略（schema 演进宽容）；必填缺失 = 违规。
 *
 * 白名单审计：``PatchKind``（补丁类型集合）= **机制固有**——类型集合绑定
 * 按类型校验分派（``_validate_{kind}``，见 proposal_validator.ts）；审批
 * 分级表（PatchKind → 分级）= **装配数据化**（宿主经配方数据注入）。
 *
 * 本文件承载 PatchKind / SelfProposal 与形态示例骨架；ProposalValidator
 * 在 proposal_validator.ts（≤350 行纪律拆分）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';

/** 补丁类型（演化对象清单：界面/主题/工具/规则/知识/harness/事件/环境/产物/实体）。 */
export const PatchKind = {
  UI: 'ui',
  THEME: 'theme',
  TOOL: 'tool',
  RULE: 'rule',
  KNOWLEDGE: 'knowledge',
  HARNESS: 'harness',
  EVENT_TYPE: 'event_type',
  ENVIRONMENT: 'environment',
  ARTIFACT: 'artifact',
  ENTITY: 'entity',
} as const;

/** PatchKind 取值联合（与 StrEnum 值集合同源）。 */
export type PatchKind = (typeof PatchKind)[keyof typeof PatchKind];

/** 全部补丁类型值（声明序，镜像 StrEnum 成员序）。 */
export const _PATCH_KIND_VALUES: readonly PatchKind[] = Object.values(PatchKind);

/** 类型集合可读形态（Python list repr：``['ui', 'theme', ...]``）。 */
export const _PATCH_KIND_VALUES_REPR = `[${_PATCH_KIND_VALUES.map((value) => pyRepr(value)).join(', ')}]`;

/** Python repr() 口径（错误文案呈现；字符串单引号、None → 'None'）。 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).map((key) => `${pyRepr(key)}: ${pyRepr(value[key])}`).join(', ')}}`;
  }
  return String(value);
}

/** Python tuple repr() 口径（白名单呈现；单元素补尾逗号）。 */
export function pyTupleRepr(items: readonly unknown[]): string {
  if (items.length === 0) return '()';
  const body = items.map(pyRepr).join(', ');
  return items.length === 1 ? `(${body},)` : `(${body})`;
}

/** 成员判定（镜像 StrEnum 构造成功即成员；非法值 = 非成员）。 */
export function is_patch_kind(value: unknown): value is PatchKind {
  return (_PATCH_KIND_VALUES as readonly unknown[]).includes(value);
}

/** Python int() 口径数值转换（数值截断 / 整数字符串解析）。 */
function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`int() 无法解析数值: ${value}`);
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const match = /^\s*[+-]?\d+\s*$/.exec(value);
    if (match !== null) return Number.parseInt(match[0]!, 10);
    throw new Error(`int() 无法解析字符串: ${pyRepr(value)}`);
  }
  throw new Error(`int() 需要数值/字符串，收到 ${typeName(value)}`);
}

/**
 * 基准版本归一（镜像 ``int(data.get('base_version') or 1)``：falsy
 * （缺省/0/空串）→ 1；无法整数化 = 声明非法显式拒绝）。
 */
function coerceBaseVersion(raw: unknown): number {
  if (!raw) return 1;
  try {
    return pyInt(raw);
  } catch {
    throw new GraphDefinitionError(`补丁基准版本非法: ${pyRepr(raw)}`);
  }
}

// 产物哈希声明形态（sha256 hex，64 字符）
const _ARTIFACT_HASH_LENGTH = 64;

// 各补丁类型的合法形态示例骨架（形态示例增强）：校验失败时随
// 违规清单回传示例骨架，供模型按形态试错收敛——避免「缺 xxx」等提示无形态
// 引导的盲目试探（如 schema 声明须嵌套 name+fields 的形态盲猜）。形态与
// seed_data/tools.json 既有条目/字段声明模板同构（tool 示例参照出厂工具
// 声明：name/description/permissions/endpoint/endpoint_config）。
const _PATCH_KIND_EXAMPLES: Record<string, string> = {
  ui: `{"spec": {"name": "...", "root": {"kind": "container", "type": "column", "children": [{"kind": "component", "type": "...", "bind": {...}}]}}}`,
  theme: '{"tokens": {"<token 名>": "<颜色值>"}}',
  tool: `{"name": "<工具名>", "description": "...", "permissions": ["filesystem:read:/workspace"], "endpoint": "file_ops", "endpoint_config": {"root": "/workspace"}}`,
  entity: `{"id": "<实体 id>", "label": "<展示名>", "persona": "<独立系统提示词>", "model": {"provider": "...", "model_id": "..."}}`,
  rule: `{"rule": {"id": "...", "predicate": "equals", "path": "status", "config": {"value": "..."}, "severity": "warning", "description": "..."}}`,
  knowledge: `{"entry": {"id": "...", "level": "user", "kind": "rule", "data": {"rule": {"id": "...", "predicate": "...", "path": "..."}}}}`,
  harness: '{"definition": {"name": "...", "description": "...", "graph": null, "tools": []}}',
  event_type: '{"name": "quest_start", "renderer": "QuestRow", "system": false}',
  environment: `{"name": "node_env", "runtime": "local", "tools": ["node"], "install_cmds": ["npm install -g pkg"]}`,
  artifact: `{"artifact_id": "...", "kind": "js_bundle", "hashes": {"index.js": "<sha256 hex 64 字符>"}}`,
};

/** 补丁类型取值的可读清单（错误文案用）。 */
export function example_skeleton(kind: string): string | undefined {
  return _PATCH_KIND_EXAMPLES[kind];
}

/** SelfProposal 构造选项（对应 Python frozen dataclass 字段）。 */
export interface SelfProposalInit {
  /** 补丁类型（机制固有枚举；非法值构造即拒绝）。 */
  kind: PatchKind;
  /** 补丁内容（按类型校验：ui/theme 走界面 schema，tool/rule/knowledge/
   *  harness/event_type/environment/entity 走各自声明构造，artifact 走产物声明）。 */
  payload: Record<string, unknown>;
  /** 提案时的集补丁链版本（应用时基准校验——基准不匹配 = 并发冲突，
   *  拒绝并要求基于最新态重提）。 */
  base_version?: number;
  /** 提案理由（审批卡展示与审计留痕）。 */
  rationale?: string;
  /** 扩展元数据（来源/回合/请求方等，宿主语义）。 */
  meta?: Record<string, unknown>;
}

/**
 * 一条演化提案（应用管线入口数据；frozen dataclass 镜像：构造后不可变）。
 */
export class SelfProposal {
  /** 补丁类型。 */
  readonly kind: PatchKind;
  /** 补丁内容（按类型校验的 payload 原样保存）。 */
  readonly payload: Record<string, unknown>;
  /** 提案时的集补丁链版本（基准校验用）。 */
  readonly base_version: number;
  /** 提案理由（审批卡展示与审计留痕）。 */
  readonly rationale: string;
  /** 扩展元数据（来源/回合/请求方等，宿主语义）。 */
  readonly meta: Record<string, unknown>;

  constructor(init: SelfProposalInit) {
    if (!is_patch_kind(init.kind)) {
      throw new GraphDefinitionError(
        `补丁类型非法: ${pyRepr(init.kind)}（仅 ${_PATCH_KIND_VALUES_REPR}）`,
      );
    }
    if (!isRecord(init.payload)) {
      throw new GraphDefinitionError(
        `补丁 ${init.kind} 的 payload 须为 dict，收到 ${typeName(init.payload)}`,
      );
    }
    const base_version = init.base_version ?? 1;
    if (base_version < 1) {
      throw new GraphDefinitionError(
        `补丁基准版本非法: ${base_version}（须 ≥ 1）`,
      );
    }
    this.kind = init.kind;
    this.payload = init.payload;
    this.base_version = base_version;
    this.rationale = init.rationale ?? '';
    this.meta = { ...(init.meta ?? {}) };
    Object.freeze(this);
  }

  /** 序列化为数据形态（空 rationale/meta 省略，最小数据形态）。 */
  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      kind: this.kind,
      payload: this.payload,
      base_version: this.base_version,
    };
    if (this.rationale) data['rationale'] = this.rationale;
    if (Object.keys(this.meta).length > 0) data['meta'] = { ...this.meta };
    return data;
  }

  /** 从声明数据还原（kind/payload 形态非法 → GraphDefinitionError）。 */
  static from_dict(data: unknown): SelfProposal {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `提案声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const rawKind = data['kind'];
    if (!is_patch_kind(rawKind)) {
      throw new GraphDefinitionError(`补丁类型非法: ${pyRepr(rawKind)}`);
    }
    const kind = rawKind as PatchKind;
    const payload = data['payload'];
    if (!isRecord(payload)) {
      throw new GraphDefinitionError(`补丁 ${kind} 的 payload 须为 dict`);
    }
    const rawMeta = data['meta'];
    return new SelfProposal({
      kind,
      payload,
      base_version: coerceBaseVersion(data['base_version']),
      rationale: (data['rationale'] as string | undefined) || '',
      meta: isRecord(rawMeta) ? { ...rawMeta } : {},
    });
  }
}
