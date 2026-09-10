/**
 * 作用域目录资产声明块（实体声明的 P5-α 延伸数据面）。
 *
 * 执行模型里「作用域 = 执行身份定义（persona/model/能力/权限/契约）」落位在
 * 实体目录（core/entities/entities.ts）上：作用域资产 = 携带本声明块的实体
 * 记录，role 字段直接命名目录身份（planner/critic/collaborator/...，实体目录
 * 既有的 persona/model/role/label/meta 已是作用域身份的主体字段）。本声明块
 * 只承载实体字段未建模的执行维度：
 *
 * - capabilities（可用能力清单：能力名 + 执行后端类别。类别按工具统一触发
 *   协议的两分：function = 能力类（函数后端，结果留在当前作用域）；
 *   organization = 组织类（作用域/通道后端，创建子执行并按归并契约返回））；
 * - rules（规则与权限声明：目录登记面，运行时裁决不在此层）；
 * - cost_tier（成本档标签：登记面数据，护栏/预算在运行时层消费）；
 * - contract（输入输出契约：消费/产出 = 形态 + schema + 归属，载荷传递的
 *   声明面；旧稿 read_fields/output_field 裸键按作用域口径升级后的落点）；
 * - guard_level（自身登记/更新/下架的审批档：值面复用数据面 APPROVAL_LEVELS，
 *   不另立第二套枚举）。
 *
 * 纯数据面（JSON 进 JSON 出）：本模块只做词汇表 + 类型 + 解析/校验，不含任何
 * 执行语义；与实体目录同一受控注册通道（EvolutionWriter + GuardedStorage，
 * 见 entities.ts）——声明块是实体记录里的可选字段，旧记录无该字段 = 非作用域
 * 资产的普通实体，序列化零漂移。
 */

import { APPROVAL_LEVELS } from '../contracts/generated/index.js';
import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';

// ── 出厂目录身份（role 词汇；与 entities.ts DEFAULT_ENTITY_ROLE 对齐于
//    collaborator，不 import 实体模块——entities 反向依赖本模块，避免环）──

export const SCOPE_ROLE_MAIN = 'main';
export const SCOPE_ROLE_PLANNER = 'planner';
export const SCOPE_ROLE_CODER = 'coder';
export const SCOPE_ROLE_CRITIC = 'critic';
export const SCOPE_ROLE_SEARCHER = 'searcher';
export const SCOPE_ROLE_TESTER = 'tester';
/** 协作者模板（值 = 实体目录缺省角色 DEFAULT_ENTITY_ROLE，见 entities.ts）。 */
export const SCOPE_ROLE_COLLABORATOR = 'collaborator';
export const SCOPE_ROLE_SUBAGENT = 'subagent';

/** 出厂预置目录身份集（能力素材的 8 个目录行，非写死拓扑——随组织择优演进）。 */
export const FACTORY_SCOPE_ROLES = [
  SCOPE_ROLE_MAIN,
  SCOPE_ROLE_PLANNER,
  SCOPE_ROLE_CODER,
  SCOPE_ROLE_CRITIC,
  SCOPE_ROLE_SEARCHER,
  SCOPE_ROLE_TESTER,
  SCOPE_ROLE_COLLABORATOR,
  SCOPE_ROLE_SUBAGENT,
] as const;

/** 目录身份（出厂 8 类或宿主自定义串）。 */
export type ScopeRole = (typeof FACTORY_SCOPE_ROLES)[number];

/** role 是否出厂目录身份（目录行识别 + 出厂素材标记）。 */
export function is_factory_scope_role(role: string): boolean {
  return (FACTORY_SCOPE_ROLES as readonly string[]).includes(role);
}

// ── 能力类（工具统一触发协议的后端两分；数据面只登记，不裁决）──

/** 能力类后端：bash/web/fs/记忆 等函数后端，结果返回留在当前作用域。 */
export const CAPABILITY_CLASS_FUNCTION = 'function';
/** 组织类后端：委托/召集/fan-out/审查 等作用域/通道后端，创建子执行。 */
export const CAPABILITY_CLASS_ORGANIZATION = 'organization';

/** 能力执行后端类别（两值：能力类 / 组织类）。 */
export type CapabilityClass = typeof CAPABILITY_CLASS_FUNCTION | typeof CAPABILITY_CLASS_ORGANIZATION;

/** 单条可用能力声明（能力名 + 执行后端类别）。 */
export interface ScopeCapability {
  id: string;
  class: CapabilityClass;
}

// ── 登记审批档（值面 = 数据面 APPROVAL_LEVELS 单一真源）──

/** 作用域资产自身登记/更新/下架的审批档取值。 */
export type ScopeGuardLevel = (typeof APPROVAL_LEVELS)[number];

/** 出厂默认登记审批档（L1 = 弹卡；出厂/宿主装配期直注不走补丁链）。 */
export const SCOPE_GUARD_DEFAULT: ScopeGuardLevel = 'L1';

// ── 输入输出契约（消费/产出：形态 + schema + 归属）──

/** 载荷形态：message = 会话消息流；field = 载荷字段（键引用）。 */
export type ScopeIoShape = 'message' | 'field';

/** 单条消费/产出绑定：形态 + 归属载体 + 可选 schema。 */
export interface ScopeIoBinding {
  shape: ScopeIoShape;
  /** 归属载体：field 形态 = 字段键；message 形态可省。 */
  key?: string;
  /** 产物 schema（校验/择优信号；登记面数据，运行时按需消费）。 */
  schema?: Record<string, unknown> | null;
  /** 归属（哪一侧声明/读写；可省）。 */
  owner?: string;
}

/** 作用域输入输出契约（消费/产出各自可多条）。 */
export interface ScopeIoContract {
  consumes?: ScopeIoBinding[];
  produces?: ScopeIoBinding[];
}

// ── 作用域声明块（实体记录可选字段 `scope` 的类型面）──

/** 作用域资产声明块（可选维度；实体既有字段 = 身份主体，不进本块）。 */
export interface ScopeDecl {
  capabilities?: ScopeCapability[];
  /** 规则与权限声明（登记面 token 清单；运行时裁决不在此层）。 */
  rules?: string[];
  /** 成本档标签（登记面；护栏/预算在运行时层消费）。 */
  cost_tier?: string;
  contract?: ScopeIoContract;
  guard_level?: ScopeGuardLevel;
}

/** 校验辅助：报错统一入口（带字段名 + 期望形态）。 */
function _bad(where: string, expected: string): never {
  const location = where === '' ? '作用域声明非法' : `作用域声明 ${where} 非法`;
  throw new GraphDefinitionError(`${location}: 期望 ${expected}`);
}

/** 解析能力清单（数组 of {id, class}）。 */
function _parse_capabilities(raw: unknown, where: string): ScopeCapability[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) _bad(`${where}.capabilities`, 'list');
  const out: ScopeCapability[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isRecord(item)) _bad(`${where}.capabilities[${i}]`, 'dict {id, class}');
    const id = item['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      _bad(`${where}.capabilities[${i}].id`, '非空字符串');
    }
    const cls = item['class'];
    if (cls !== CAPABILITY_CLASS_FUNCTION && cls !== CAPABILITY_CLASS_ORGANIZATION) {
      _bad(`${where}.capabilities[${i}].class`, 'function | organization');
    }
    out.push({ id, class: cls });
  }
  return out;
}

/** 解析规则/权限 token 清单。 */
function _parse_rules(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) _bad(`${where}.rules`, 'list');
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== 'string' || (raw[i] as string).trim() === '') {
      _bad(`${where}.rules[${i}]`, '非空字符串');
    }
    out.push(raw[i] as string);
  }
  return out;
}

/** 解析单条消费/产出绑定。 */
function _parse_binding(raw: unknown, where: string): ScopeIoBinding {
  if (!isRecord(raw)) _bad(where, 'dict');
  const shape = raw['shape'];
  if (shape !== 'message' && shape !== 'field') _bad(`${where}.shape`, 'message | field');
  const binding: ScopeIoBinding = { shape };
  const key = raw['key'];
  if (key !== undefined) {
    if (typeof key !== 'string') _bad(`${where}.key`, 'string');
    binding.key = key;
  }
  const schema = raw['schema'];
  if (schema !== undefined && schema !== null) {
    if (!isRecord(schema)) _bad(`${where}.schema`, 'dict | null');
    binding.schema = { ...schema };
  }
  const owner = raw['owner'];
  if (owner !== undefined) {
    if (typeof owner !== 'string') _bad(`${where}.owner`, 'string');
    binding.owner = owner;
  }
  return binding;
}

/** 解析契约（consumes/produces 绑定清单）。 */
function _parse_contract(raw: unknown, where: string): ScopeIoContract | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) _bad(`${where}.contract`, 'dict');
  const contract: ScopeIoContract = {};
  for (const side of ['consumes', 'produces'] as const) {
    const list = raw[side];
    if (list === undefined) continue;
    if (!Array.isArray(list)) _bad(`${where}.contract.${side}`, 'list');
    contract[side] = list.map((item, i) =>
      _parse_binding(item, `${where}.contract.${side}[${i}]`),
    );
  }
  return contract;
}

/**
 * 从 JSON 解析作用域声明块（实体记录 `scope` 字段的反序列化面）。
 * 未知键忽略（前向兼容）；字段类型/取值非法 = 显式抛错（fail-closed，
 * 与实体其余字段校验同口径）。
 */
export function parse_scope_decl(data: unknown): ScopeDecl {
  if (data === undefined || data === null) return {};
  if (!isRecord(data)) _bad('', 'dict');
  const decl: ScopeDecl = {};
  const capabilities = _parse_capabilities(data['capabilities'], 'scope');
  if (capabilities.length > 0) decl.capabilities = capabilities;
  const rules = _parse_rules(data['rules'], 'scope');
  if (rules.length > 0) decl.rules = rules;
  const costTier = data['cost_tier'];
  if (costTier !== undefined) {
    if (typeof costTier !== 'string') _bad('scope.cost_tier', 'string');
    decl.cost_tier = costTier;
  }
  const contract = _parse_contract(data['contract'], 'scope');
  if (contract !== undefined) decl.contract = contract;
  const guardLevel = data['guard_level'];
  if (guardLevel !== undefined) {
    if ((APPROVAL_LEVELS as readonly string[]).includes(String(guardLevel))) {
      decl.guard_level = guardLevel as ScopeGuardLevel;
    } else {
      _bad('scope.guard_level', `APPROVAL_LEVELS 之一 (${APPROVAL_LEVELS.join('/')})`);
    }
  }
  return decl;
}

/** 深拷贝作用域声明块（序列化面；防别名改写实体记录）。 */
export function scope_decl_to_dict(decl: ScopeDecl): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (decl.capabilities !== undefined) {
    out['capabilities'] = decl.capabilities.map((c) => ({ id: c.id, class: c.class }));
  }
  if (decl.rules !== undefined) out['rules'] = [...decl.rules];
  if (decl.cost_tier !== undefined) out['cost_tier'] = decl.cost_tier;
  if (decl.contract !== undefined) {
    const contract: Record<string, unknown> = {};
    for (const side of ['consumes', 'produces'] as const) {
      const list = decl.contract[side];
      if (list === undefined) continue;
      contract[side] = list.map((b) => {
        const item: Record<string, unknown> = { shape: b.shape };
        if (b.key !== undefined) item['key'] = b.key;
        if (b.schema !== undefined && b.schema !== null) item['schema'] = { ...b.schema };
        if (b.owner !== undefined) item['owner'] = b.owner;
        return item;
      });
    }
    out['contract'] = contract;
  }
  if (decl.guard_level !== undefined) out['guard_level'] = decl.guard_level;
  return out;
}
