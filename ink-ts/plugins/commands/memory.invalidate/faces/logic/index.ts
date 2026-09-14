/**
 * memory.invalidate 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/memory.ts
 * 迁入，语义零改）。批量失效（ids 全量尝试；缺失条目记 not_found，不阻断其余）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';

export default function createMemoryInvalidate(deps: HostBridgeDeps): BridgeHandler {
  /** 批量失效（ids 全量尝试；缺失条目记 not_found，不阻断其余）。 */
  const invalidate: BridgeHandler = async (raw): Promise<unknown> => {
    const store = deps.runtime.memory_store;
    if (store === null) {
      throw new BridgeError('记忆库未装配（memory_extract 开关关闭）', 'runtime_unavailable');
    }
    const params = raw as { ids?: unknown } | null;
    const ids =
      params !== null && Array.isArray(params.ids)
        ? (params.ids as unknown[]).filter((id): id is string => typeof id === 'string')
        : null;
    if (ids === null) {
      throw new BridgeError('memory.invalidate 需 params.ids（字符串清单）', 'invalid_params');
    }
    if ((params!.ids as unknown[]).some((id) => typeof id !== 'string')) {
      throw new BridgeError('memory.invalidate ids 须为字符串清单', 'invalid_params');
    }
    let invalidated = 0;
    const notFound: string[] = [];
    for (const id of ids) {
      const ok = await store.delete(id).catch(() => false);
      if (ok) invalidated += 1;
      else notFound.push(id);
    }
    return { total: ids.length, invalidated, not_found: notFound };
  };

  return invalidate;
}
