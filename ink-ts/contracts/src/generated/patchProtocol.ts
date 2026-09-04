// 生成文件（generated）：由 scripts/generate.mjs 依据 contracts/schemas 与 fixtures 生成，勿手改。数据面契约以 JSON 为准。

export const PATCH_KINDS = [
  "ui",
  "theme",
  "tool",
  "rule",
  "knowledge",
  "harness",
  "event_type",
  "environment",
  "artifact",
  "entity",
] as const satisfies readonly ("ui" | "theme" | "tool" | "rule" | "knowledge" | "harness" | "event_type" | "environment" | "artifact" | "entity")[];

export type PatchKind = (typeof PATCH_KINDS)[number];

export const APPROVAL_LEVELS = [
  "L0",
  "L1",
  "L2",
] as const satisfies readonly ("L0" | "L1" | "L2")[];

export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export type KnownDefaultPatchKind = Exclude<PatchKind, 'entity'>;

export const DEFAULT_APPROVAL_LEVELS = {
  "ui": "L0",
  "theme": "L0",
  "tool": "L1",
  "rule": "L1",
  "knowledge": "L1",
  "harness": "L1",
  "event_type": "L1",
  "environment": "L1",
  "artifact": "L2",
} as const satisfies Record<KnownDefaultPatchKind, ApprovalLevel>;

export const AUDIT_STATUSES = [
  "applied",
  "rejected",
  "conflict",
  "invalid",
  "reverted",
  "reverted_with_notify_error",
] as const satisfies readonly ("applied" | "rejected" | "conflict" | "invalid" | "reverted" | "reverted_with_notify_error")[];

export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const PATCH_OPS = [
  "append",
  "replace",
  "delete",
] as const satisfies readonly ("append" | "replace" | "delete")[];

export type PatchOp = (typeof PATCH_OPS)[number];

export const GUARDED_COLLECTIONS = [
  "set_patch_chain",
  "set_audit",
  "ui",
  "tool_defs",
  "event_types",
  "environments",
  "artifacts",
  "harness",
  "entities",
] as const;

export const GUARDED_PREFIXES = [
  "knowledge:",
  "harness:",
  "event_types:",
  "entities:",
] as const;
