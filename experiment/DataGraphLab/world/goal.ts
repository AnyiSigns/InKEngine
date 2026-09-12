/**
 * 目标谓词（仅 `spec` 可见，绝不进主臂特征）。
 *
 * 类型守卫是硬要求：`parity`/`gt` 只接受 Int，`len` 只接受 Str；类型不匹配一律
 * 返回 false，不抛异常、不隐式转换（防 `echo` 等跨类型产物触发未定义行为）。
 */

import { emod } from './operators.js';

export type Goal =
  | { readonly kind: 'parity'; readonly target: 0 | 1 }
  | { readonly kind: 'gt'; readonly target: number }
  | { readonly kind: 'len'; readonly min: number; readonly max: number }
  | { readonly kind: 'all'; readonly of: readonly Goal[] };

export function goalOk(value: unknown, spec: { readonly goal: Goal }): boolean {
  const g = spec.goal;
  switch (g.kind) {
    case 'parity':
      if (!Number.isInteger(value)) return false;
      return emod(value as number, 2) === g.target;
    case 'gt':
      if (!Number.isInteger(value)) return false;
      return (value as number) > g.target;
    case 'len':
      if (typeof value !== 'string') return false;
      return value.length >= g.min && value.length <= g.max;
    case 'all':
      return g.of.every((sub) => goalOk(value, { goal: sub }));
  }
}
