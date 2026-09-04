/**
 * 点分路径取值（rules.py _get_path 移植，谓词与执行引擎共用的数据访问面）。
 *
 * 属性/字典键/列表下标逐段解析；空路径 = 对象本身。解析失败或值为
 * None 均返回 null——「字段缺失 = 规则不适用」由引擎跳过（适用性显式
 * 断言用 present/absent 谓词，不混在取值里）。下划线前缀段（dunder/
 * 私有成员）一律拒绝返回 null：规则 DSL 是受限数据访问（LLM 生成声明），
 * 不暴露对象内部属性。负列表下标属越权访问，视作路径非法/不适用。
 */

import { isRecord } from '../json.js';

/** 点分路径取值；下划线段/越界下标/属性访问异常一律归为 null。 */
export function getPath(obj: unknown, path: string | null | undefined): unknown {
  if (!path) return obj;
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || segment.startsWith('_')) {
      return null;
    }
    if (isRecord(current)) {
      current = current[segment] ?? null;
    } else if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return null;
      const index = Number(segment);
      current = index < current.length ? current[index] : null;
    } else if (typeof current === 'object') {
      // 其余对象形态按属性访问兜底（getter 异常视作缺失，不穿透破坏
      // fail-open 闭环）；标量不可继续下钻
      try {
        current = (current as Record<string, unknown>)[segment] ?? null;
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  return current;
}