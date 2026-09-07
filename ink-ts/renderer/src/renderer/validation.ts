/**
 * ui_spec 结构校验（损坏 ui_spec 回落基线不崩溃）。
 *
 * 校验面：根节点必须存在且为对象、kind ∈ {container, component}、
 * 容器 children 为数组、组件 type 为非空字符串、bind 为 {channel, path}。
 * 任一层级违规 → 判定损坏 → 渲染器回落基线布局（不抛异常、不白屏）。
 */

import { logger } from '@/shared/logger';
import type { UISpec } from './uiSpecTypes';

export interface ValidationResult {
  ok: boolean;
  /** 违规描述（首个违规，供日志与占位展示） */
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateBind(bind: unknown): string | null {
  if (bind === undefined) return null;
  if (!isRecord(bind)) return 'bind 须为对象';
  if (typeof bind.channel !== 'string' || bind.channel === '') return 'bind.channel 须为非空字符串';
  if (bind.path !== undefined && typeof bind.path !== 'string') return 'bind.path 须为字符串';
  return null;
}

function validateNode(node: unknown, path: string, depth: number): string | null {
  if (depth > 64) return `${path} 层级过深（超过 64 层）`;
  if (!isRecord(node)) return `${path} 节点须为对象`;
  if (node.kind !== 'container' && node.kind !== 'component') return `${path}.kind 非法（须为 container/component）`;
  if (typeof node.type !== 'string' || node.type === '') return `${path}.type 须为非空字符串`;
  if (node.props !== undefined && !isRecord(node.props)) return `${path}.props 须为对象`;
  const bindError = validateBind(node.bind);
  if (bindError) return `${path}.bind ${bindError}`;
  if (node.kind === 'container') {
    if (node.children !== undefined && !Array.isArray(node.children)) return `${path}.children 须为数组`;
    for (let index = 0; index < (node.children?.length ?? 0); index += 1) {
      const error = validateNode(node.children?.[index], `${path}.children[${index}]`, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

/**
 * 结构校验：损坏（含根缺失/字段类型错误/递归违规）返回 { ok: false }。
 * 校验不抛异常——损坏输入即回落基线，渲染器永不因 spec 崩溃。
 */
export function validateUiSpec(spec: unknown): ValidationResult {
  if (spec === null || spec === undefined) return { ok: false, reason: '界面描述缺失' };
  if (!isRecord(spec)) return { ok: false, reason: '界面描述须为对象' };
  if (typeof spec.name !== 'string' || spec.name === '') return { ok: false, reason: '界面描述缺少 name' };
  if (spec.theme !== undefined && !isRecord(spec.theme)) return { ok: false, reason: 'theme 须为对象' };
  if (spec.root === null || spec.root === undefined) return { ok: false, reason: '界面描述缺少 root 布局树' };
  const rootError = validateNode(spec.root, 'root', 0);
  if (rootError) return { ok: false, reason: rootError };
  return { ok: true };
}

/** 记录损坏现场（结构化日志；渲染器据此回落基线）。 */
export function logSpecDamage(specName: string, reason: string): void {
  logger.warn('renderer', '损坏 ui_spec 回落基线', { spec: specName, reason });
}

/** 规范化：通过校验的输入收敛为 UISpec（防脏字段侵入组件层）。 */
export function normalizeSpec(spec: UISpec): UISpec {
  const theme: Record<string, string> = {};
  if (isRecord(spec.theme)) {
    for (const [key, value] of Object.entries(spec.theme)) {
      if (typeof value === 'string') theme[key] = value;
    }
  }
  return { name: spec.name, version: spec.version, theme, root: spec.root };
}
