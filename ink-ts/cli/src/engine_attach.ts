/**
 * 引擎全局事件传输挂载（cli 装配产物，非 host 改动）。
 *
 * host bridge rounds 走 run 级组装回合：每轮回合建临时 Engine，事件既推
 * run 级 transports，也推引擎 options.transports（runtime 自接线把 growth/
 * 实体演化/回合步骤记录器挂在这里；宿主无静态引擎时还带 runtime.round_
 * transports 观察链）。cli 经同一 seam 追加自身观察传输——serve 事件订阅 /
 * run 实时进度因此能收到全部回合事件，无需复制 host 装配逻辑。
 */

import type { Runtime } from '@ink-ts/engine';
import type { EngineTransport } from '@ink-ts/engine';

/** 往引擎回合事件链追加一个观察传输；返回解挂函数（幂等）。
 *  组装回合引擎为每轮临时实例——观察传输挂 runtime.round_transports（每轮
 *  重建都带）；静态引擎存在时同时挂引擎 options.transports（旧路径兼容）。 */
export function attachEngineTransport(
  runtime: Runtime,
  transport: EngineTransport,
): () => void {
  const detachAll: Array<() => void> = [];
  const roundList = runtime.round_transports;
  if (Array.isArray(roundList)) {
    roundList.push(transport);
    let detached = false;
    detachAll.push(() => {
      if (detached) return;
      detached = true;
      const index = roundList.indexOf(transport);
      if (index >= 0) roundList.splice(index, 1);
    });
  }
  const engine = runtime.engine;
  if (engine !== null) {
    const opts = engine as unknown as { options: { transports: EngineTransport[] } };
    const list = opts.options.transports;
    list.push(transport);
    let detached = false;
    detachAll.push(() => {
      if (detached) return;
      detached = true;
      const index = list.indexOf(transport);
      if (index >= 0) list.splice(index, 1);
    });
  }
  return (): void => {
    for (const detach of detachAll) detach();
  };
}
