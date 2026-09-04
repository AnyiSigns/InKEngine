/**
 * 声明式工具流水线接线钩子（declarative_tools.py :847-882 移植）。
 *
 * make_declarative_extractor / make_declarative_failure_reason：把
 * spec.name 反查声明式定义 → 端点类型推导判定目标（declarative_operation
 * / declarative_failure_reason）的语义包装成 ToolPipeline.extractor /
 * failure_reason 形状。目标无法判定返回 None——ToolPipeline 对提取器
 * 返回 None 且非 allow_unchecked 的调用 fail-closed 拒绝（无法判定
 * 目标 = 无法做权限/沙箱判定，不直通执行）。失败原因同源反查定义，
 * 拒绝文案携带结构化缺参/非法原因，指引模型自我纠正。
 */
import { ToolSpec } from '../llm/tools.js';
import type { DeclarativeToolExecutors } from './executors.js';
import { declarative_failure_reason, declarative_operation } from './operations.js';

/** 声明式工具的操作提取器（ToolPipeline.extractor 接线）。 */
export function make_declarative_extractor(
  executors: DeclarativeToolExecutors,
): (spec: ToolSpec, args: Record<string, unknown>) => [string, string] | null {
  return (spec: ToolSpec, args: Record<string, unknown>): [string, string] | null => {
    const definition = executors.definitions[spec.name];
    if (definition === undefined) return null;
    return declarative_operation(definition, args);
  };
}

/** 声明式工具的判定失败原因钩子（ToolPipeline.failure_reason 接线）。 */
export function make_declarative_failure_reason(
  executors: DeclarativeToolExecutors,
): (spec: ToolSpec, args: Record<string, unknown>) => string | null {
  return (spec: ToolSpec, args: Record<string, unknown>): string | null => {
    const definition = executors.definitions[spec.name];
    if (definition === undefined) return null;
    return declarative_failure_reason(definition, args);
  };
}
