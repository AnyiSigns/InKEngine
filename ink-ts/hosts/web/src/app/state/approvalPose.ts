/**
 * 弹卡档位宿主存储助手（B2：输入框三档 → 会话覆盖 + 宿主默认）。
 *
 * 语义：review = 默认档（宿主设置）；auto/deny = 会话内临时切换只对本会话
 * 生效（按 activeSessionId 记覆盖）；无活动会话时切换 = 改宿主默认。
 * 纯浏览器 localStorage；不可用时一律回落 review（fail-closed 语义：
 * 不知道用户改过什么就按最保守的 review 走）。
 */

import type { ApprovalPose } from '@/shared/backend/backendAdapter';

export const DEFAULT_APPROVAL_POSE: ApprovalPose = 'review';

const DEFAULT_KEY = 'ink.approvalPose.default';
const OVERRIDES_KEY = 'ink.approvalPose.bySession';

const POSES: readonly ApprovalPose[] = ['auto', 'review', 'deny'];

export function isApprovalPose(value: unknown): value is ApprovalPose {
  return typeof value === 'string' && (POSES as readonly string[]).includes(value);
}

function readJson(key: string): Record<string, string> | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: Record<string, string>): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用 = 不落盘，运行时仍按内存态生效
  }
}

/** 宿主默认档（未设置/损坏/不可用 = review）。 */
export function loadDefaultPose(): ApprovalPose {
  try {
    const raw = globalThis.localStorage?.getItem(DEFAULT_KEY);
    return isApprovalPose(raw) ? raw : DEFAULT_APPROVAL_POSE;
  } catch {
    return DEFAULT_APPROVAL_POSE;
  }
}

export function saveDefaultPose(pose: ApprovalPose): void {
  try {
    globalThis.localStorage?.setItem(DEFAULT_KEY, pose);
  } catch {
    // 存储不可用 = 静默（运行时内存态仍生效）
  }
}

/** 会话覆盖表（{ [sessionId]: pose }）。 */
export function loadPoseOverrides(): Record<string, ApprovalPose> {
  const map = readJson(OVERRIDES_KEY) ?? {};
  const out: Record<string, ApprovalPose> = {};
  for (const [id, pose] of Object.entries(map)) {
    if (isApprovalPose(pose)) out[id] = pose;
  }
  return out;
}

export function savePoseOverride(sessionId: string, pose: ApprovalPose): void {
  const map = readJson(OVERRIDES_KEY) ?? {};
  map[sessionId] = pose;
  writeJson(OVERRIDES_KEY, map);
}

/** 当前会话生效档：会话覆盖 ?? 宿主默认。 */
export function effectivePose(
  defaultPose: ApprovalPose,
  overrides: Record<string, ApprovalPose>,
  sessionId: string | null | undefined,
): ApprovalPose {
  if (sessionId) {
    const override = overrides[sessionId];
    if (isApprovalPose(override)) return override;
  }
  return defaultPose;
}
