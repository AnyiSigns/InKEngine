/**
 * 审批分级面（core/self_application.py ApprovalLevel / 分级表 / 超时
 * 窗口 / L2 校验钩子移植）。
 *
 * 审批分级为产品层语义（映射引擎既有策略）：
 * - L0 = 策略直过（auto_approve_keys 白名单）；
 * - L1 = 弹卡快速确认（approve_before_execute）；
 * - L2 = 沙箱验证 + 人工审批（vetting 通过才弹卡）。
 *
 * 默认分级：低风险形态（主题/界面微调）L0 直过；工具/规则/知识/
 * harness/事件/环境 L1 弹卡；构建产物引用（哈希+冒烟门禁语义）L2
 * 沙箱验证 + 人工审批。宿主可整体替换（如把 artifact promote 提升 L2）。
 *
 * 数据面单源：ApprovalLevel 值集合与 DEFAULT_APPROVAL_LEVELS 分级表 =
 * contracts generated（APPROVAL_LEVELS / DEFAULT_APPROVAL_LEVELS）；
 * 本地对象为命名映射（引擎取值入口），经编译期集合相等绑定 + 运行时
 * assert_approval_levels_contract 双向校验，不维护第二套语义枚举。
 */

import {
  APPROVAL_LEVELS,
  DEFAULT_APPROVAL_LEVELS as CONTRACT_DEFAULT_APPROVAL_LEVELS,
  type ApprovalLevel as ContractApprovalLevel,
} from '@ink-ts/contracts';
import type { PatchKind, SelfProposal } from '../self_proposal/index.js';
import { GraphDefinitionError } from '../errors.js';

/**
 * 审批分级枚举（镜像 StrEnum 取值面：L0/L1/L2 字符串字面量）。
 */
export const ApprovalLevel = {
  L0: 'L0',
  L1: 'L1',
  L2: 'L2',
} as const;

/** ApprovalLevel 取值联合（与 StrEnum 值集合同源）。 */
export type ApprovalLevel = (typeof ApprovalLevel)[keyof typeof ApprovalLevel];

// 编译期绑定：ApprovalLevel 值集合与 generated APPROVAL_LEVELS 双向精确相等
// （任一方向新增/删除/改名 → 类型错误）；运行时一致性由
// assert_approval_levels_contract 兜底（测试调用）。
type _StringSetEqual<A extends string, B extends string> = Exclude<A, B> extends never
  ? Exclude<B, A> extends never
    ? true
    : false
  : false;
const _approvalLevelsCoverContract: true = true as _StringSetEqual<
  ContractApprovalLevel,
  (typeof ApprovalLevel)[keyof typeof ApprovalLevel]
>;

/**
 * 默认分级表（kind → L0/L1/L2；ENTITY 未登记 = 缺省 L1 弹卡）。
 * 值来源 = contracts generated DEFAULT_APPROVAL_LEVELS（数据面单源，本地
 * 只保留引擎取值入口形态；逐项相等由 assert_approval_levels_contract
 * 校验）。键集合为机制固有（PatchKind），分级值为装配数据（宿主可整体
 * 替换）。
 */
export const DEFAULT_APPROVAL_LEVELS: Readonly<Partial<Record<PatchKind, ApprovalLevel>>> = {
  ...CONTRACT_DEFAULT_APPROVAL_LEVELS,
};

/**
 * 运行时断言：ApprovalLevel 值集合与默认分级表 ↔ contracts generated 一致
 * （防绕过类型层的运行时漂移，由引擎测试调用）。
 */
export function assert_approval_levels_contract(): void {
  const engineValues = Object.values(ApprovalLevel);
  const contractValues = APPROVAL_LEVELS as readonly string[];
  if (
    engineValues.length !== contractValues.length
    || !engineValues.every((value) => contractValues.includes(value))
  ) {
    throw new GraphDefinitionError(
      'ApprovalLevel 与 contracts APPROVAL_LEVELS 不一致: '
        + `engine=[${engineValues.join(', ')}] vs contracts=[${contractValues.join(', ')}]`,
    );
  }
  const engineEntries = Object.entries(DEFAULT_APPROVAL_LEVELS).sort(([a], [b]) => a.localeCompare(b));
  const contractEntries = Object.entries(CONTRACT_DEFAULT_APPROVAL_LEVELS).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const repr = (entries: [string, unknown][]): string =>
    `{${entries.map(([k, v]) => `${k}: ${String(v)}`).join(', ')}}`;
  if (JSON.stringify(engineEntries) !== JSON.stringify(contractEntries)) {
    throw new GraphDefinitionError(
      'DEFAULT_APPROVAL_LEVELS 与 contracts 不一致: '
        + `engine=${repr(engineEntries)} vs contracts=${repr(contractEntries)}`,
    );
  }
}

// 审批挂起窗口（默认 7 天）：超时未决自动过期回滚（approval 机制
// 按 expires_at 判定，过期重入一律 reject + 留痕，fail-closed）
export const APPROVAL_TIMEOUT_SECONDS: number = 7 * 24 * 3600;

/** L2 额外校验钩子签名：提案 → 违规清单（空 = 通过沙箱验证）。 */
export type L2VettingHook = (proposal: SelfProposal) => string[];
