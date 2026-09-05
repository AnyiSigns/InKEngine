/**
 * 自指应用管线常量面（core/self_application.py 顶层常量移植）。
 *
 * 应用 = 提案落地的唯一路径：校验（ProposalValidator）→ 基准冲突
 * 检测（并发提案 base 不匹配拒绝重提）→ 审批分级（L0 策略直过 /
 * L1 弹卡 / L2 沙箱验证 + 人工）→ 补丁链 append → 审计留痕 →
 * 活跃态应用（ApplyTarget 钩子）。回退 = 链级操作：仅允许回退链尾
 * 补丁（其上存在后继补丁 = 拒绝，保持链完整性）。
 *
 * 本文件只承载模块级常量：集补丁链/审计持久化集合与键、补丁落点
 * 路径段（集状态结构）、段 → 类型映射（SEGMENT_TO_KIND）、旁路写
 * 防护的演化资产集合与前缀、审批动作 key 前缀与审计状态常量。
 *
 * 数据面单源：守卫集合/前缀/审计状态值集合 = contracts generated
 * （GUARDED_COLLECTIONS / GUARDED_PREFIXES / AUDIT_STATUSES）——本地
 * 不维护同值第二套字面量；一致性由编译期绑定与 assert_constants_contract
 * 运行时兜底（测试调用）。
 */

import {
  AUDIT_STATUSES,
  GUARDED_COLLECTIONS as CONTRACT_GUARDED_COLLECTIONS,
  GUARDED_PREFIXES as CONTRACT_GUARDED_PREFIXES,
  type AuditStatus,
} from '@ink-ts/contracts';
import { GraphDefinitionError } from '../errors.js';

// 集补丁链持久化集合与键（通用存储服务 records 通道）
export const _SET_CHAIN_COLLECTION = 'set_patch_chain';
export const _SET_CHAIN_KEY = 'chain';

// 集演化审计集合（append-only，历史不撒谎）；公开别名供宿主观察侧
// （孵化/指标聚合）复用同一权威集合名，避免双份字面量漂移
export const _SET_AUDIT_COLLECTION = 'set_audit';
export const SET_AUDIT_COLLECTION = _SET_AUDIT_COLLECTION;

// 补丁落点路径段（集状态结构：组装产物即集状态全量）
export const _PATH_UI = 'ui';
export const _PATH_THEME = 'theme';
export const _PATH_TOOLS = 'tools';
export const _PATH_RULES = 'rules';
export const _PATH_KNOWLEDGE = 'knowledge';
export const _PATH_HARNESS = 'harness';
export const _PATH_EVENT_TYPES = 'event_types';
export const _PATH_ENTITIES = 'entities';
export const _PATH_ENVIRONMENTS = 'environments';
export const _PATH_ARTIFACTS = 'artifacts';

/**
 * 补丁路径段 → 补丁类型（回退审计的 last_patch 路径段反推类型用）。
 * 与上方落点路径段同源单一维护（宿主观察侧复用，避免第二份映射漂移）。
 */
export const SEGMENT_TO_KIND: Record<string, string> = {
  [_PATH_UI]: 'ui',
  [_PATH_THEME]: 'theme',
  [_PATH_TOOLS]: 'tool',
  [_PATH_RULES]: 'rule',
  [_PATH_KNOWLEDGE]: 'knowledge',
  [_PATH_HARNESS]: 'harness',
  [_PATH_EVENT_TYPES]: 'event_type',
  [_PATH_ENVIRONMENTS]: 'environment',
  [_PATH_ARTIFACTS]: 'artifact',
};

/**
 * 旁路写防护的演化资产集合（唯一写入路径 = 本管线）。
 * 精确集合 + 前缀集合两类：知识/规则条目落 knowledge:<user_id> 集合
 * （动态前缀，见 knowledge_set 的集合命名），前缀匹配兜底——规则以
 * kind=rule 知识条目同落此集合，一并受守卫。
 * ENG1-20 核对结论：知识集权威集合名 = knowledge_collection(user_id)
 * （knowledge_set.py:82 前缀 "knowledge:" + 用户 id），**不存在**精确名
 * "knowledge" 集合——动态用户集只能前缀守卫。
 */
export const _GUARDED_COLLECTIONS: ReadonlySet<string> = new Set<string>([
  ...CONTRACT_GUARDED_COLLECTIONS,
]);

/**
 * 前缀集合（按集/按用户隔离的动态集合名一律前缀守卫）：
 * knowledge:<user_id>（知识/规则条目）、harness:<set_id>（能力包仓库）、
 * event_types:<set_id>（演化事件类型）、entities:<set_id>（协作者目录）——
 * 集合名带 set_id 后精确名匹配不再命中，缺前缀守卫 = 演化资产直写无闸门。
 * 值来源 = contracts generated GUARDED_PREFIXES（本地无第二套字面量）。
 */
export const _GUARDED_PREFIXES: readonly string[] = CONTRACT_GUARDED_PREFIXES;

// 审批动作 key 前缀（挂卡/直过的依据；L0 名单按 key 注入策略）
export const _APPROVAL_KEY_PREFIX = 'patch';

// 审计状态（声明式枚举，防魔法字符串；值面绑定 contracts AuditStatus 类型，
// 集合相等由 assert_constants_contract 校验）
export const AUDIT_STATUS_APPLIED: AuditStatus = 'applied';
export const AUDIT_STATUS_REJECTED: AuditStatus = 'rejected';
export const AUDIT_STATUS_CONFLICT: AuditStatus = 'conflict';
export const AUDIT_STATUS_INVALID: AuditStatus = 'invalid';
export const AUDIT_STATUS_REVERTED: AuditStatus = 'reverted';
// 回退已落链但回退后通知（活跃态回滚钩子）失败：审计不得记成功态
// （链已回退 ≠ 运行时态已回滚——两者分叉必须可观测，见 revert）
export const AUDIT_STATUS_REVERTED_NOTIFY_FAILED: AuditStatus = 'reverted_with_notify_error';

/** 审计状态取值（声明序，随命名常量集合构建——单点维护无第二份字面量）。 */
const _AUDIT_STATUS_VALUES = [
  AUDIT_STATUS_APPLIED,
  AUDIT_STATUS_REJECTED,
  AUDIT_STATUS_CONFLICT,
  AUDIT_STATUS_INVALID,
  AUDIT_STATUS_REVERTED,
  AUDIT_STATUS_REVERTED_NOTIFY_FAILED,
] as const satisfies readonly AuditStatus[];

/**
 * 运行时断言：守卫集合/前缀与审计状态 ↔ contracts generated 一致（防绕过
 * 类型层的运行时漂移，由引擎测试调用）。
 */
export function assert_constants_contract(): void {
  const collections = [..._GUARDED_COLLECTIONS].sort();
  const contractCollections = [...CONTRACT_GUARDED_COLLECTIONS].sort();
  if (
    collections.length !== contractCollections.length
    || collections.some((name, index) => name !== contractCollections[index])
  ) {
    throw new GraphDefinitionError(
      '守卫集合与 contracts GUARDED_COLLECTIONS 不一致: '
        + `engine=[${collections.join(', ')}] vs contracts=[${contractCollections.join(', ')}]`,
    );
  }
  const prefixes = [..._GUARDED_PREFIXES];
  const contractPrefixes = [...CONTRACT_GUARDED_PREFIXES];
  if (
    prefixes.length !== contractPrefixes.length
    || prefixes.some((prefix, index) => prefix !== contractPrefixes[index])
  ) {
    throw new GraphDefinitionError(
      '守卫前缀与 contracts GUARDED_PREFIXES 不一致: '
        + `engine=[${prefixes.join(', ')}] vs contracts=[${contractPrefixes.join(', ')}]`,
    );
  }
  const statuses = [..._AUDIT_STATUS_VALUES];
  const contractStatuses = [...AUDIT_STATUSES];
  if (
    statuses.length !== contractStatuses.length
    || statuses.some((status, index) => status !== contractStatuses[index])
  ) {
    throw new GraphDefinitionError(
      '审计状态与 contracts AUDIT_STATUSES 不一致: '
        + `engine=[${statuses.join(', ')}] vs contracts=[${contractStatuses.join(', ')}]`,
    );
  }
}
