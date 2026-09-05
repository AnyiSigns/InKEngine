/**
 * growth 模块私有纯函数（事件来源派生/踩坑消息装配/Python 真值口径）。
 *
 * growth.py 的模块级私有函数面：_source_from_event（事件来源派生）留在本
 * 模块；str(... or 缺省) 的 falsy 口径（pyTruthy/_pitfall_message）在此单点
 * 定义，供观察侧装配踩坑信号。TS core 零 IO，全部为纯函数。
 */

import type { JsonRecord } from '../json.js';
import { EngineEvent } from '../events/events.js';
import { SOURCE_MODEL, SOURCE_USER } from '../knowledge_set/index.js';
import { SOURCE_RANK } from '../knowledge_signals/index.js';

// 族收敛：pyTruthy 近似拷贝的统一迁移点 = core/py_repr.ts 单源（已就绪）；
// 本实现与 rules/_py.ts pyTruthy 语义一致。后续批次可按批迁移，本文件暂不
// 改实现。
/** Python 真值口径（message 装配/来源守卫用；空容器同样为假）。 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * 踩坑信号内容装配（镜像 Python：message 缺省回落「工具执行失败」；str
 * 结果仍为空时附工具名——`payload.get("message") or 默认` 的 falsy 口径）。
 */
export function pitfall_message(payload: JsonRecord): string {
  const raw = payload['message'];
  const tool = payload['tool'];
  const first = pyTruthy(raw) ? String(raw) : '工具执行失败';
  if (first !== '') return first;
  return `工具执行失败: ${pyTruthy(tool) ? String(tool) : ''}`;
}

/** 事件来源派生：评审决议类事件 = 用户来源；其余取负载声明。 */
export function source_from_event(event: EngineEvent): string {
  const payload = event.payload ?? {};
  const raw = payload['source'];
  if (typeof raw === 'string' && raw in SOURCE_RANK) {
    return raw;
  }
  if (['accept', 'edit', 'reject', 'user_correction'].includes(event.type)) {
    return SOURCE_USER;
  }
  return SOURCE_MODEL;
}
