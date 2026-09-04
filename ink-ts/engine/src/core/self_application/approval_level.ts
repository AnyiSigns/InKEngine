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
 */

import type { PatchKind, SelfProposal } from '../self_proposal/index.js';

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

/**
 * 默认分级表（kind → L0/L1/L2；ENTITY 未登记 = 缺省 L1 弹卡）。
 * 键集合为机制固有（PatchKind），分级值为装配数据（宿主可整体替换）。
 */
export const DEFAULT_APPROVAL_LEVELS: Readonly<Partial<Record<PatchKind, ApprovalLevel>>> = {
  theme: ApprovalLevel.L0,
  ui: ApprovalLevel.L0,
  tool: ApprovalLevel.L1,
  rule: ApprovalLevel.L1,
  knowledge: ApprovalLevel.L1,
  harness: ApprovalLevel.L1,
  event_type: ApprovalLevel.L1,
  environment: ApprovalLevel.L1,
  artifact: ApprovalLevel.L2,
};

// 审批挂起窗口（默认 7 天）：超时未决自动过期回滚（approval 机制
// 按 expires_at 判定，过期重入一律 reject + 留痕，fail-closed）
export const APPROVAL_TIMEOUT_SECONDS: number = 7 * 24 * 3600;

/** L2 额外校验钩子签名：提案 → 违规清单（空 = 通过沙箱验证）。 */
export type L2VettingHook = (proposal: SelfProposal) => string[];
