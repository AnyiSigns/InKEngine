/**
 * 引擎全局事件传输挂载（cli 装配产物，非 host 改动）。
 *
 * host bridge rounds 走 engine.ainvoke 时，事件既推 run 级 transports，也推
 * 引擎 options.transports（runtime 自接线就把 growth/实体演化/回合步骤记录器
 * 挂在这里）。cli 经同一 seam 追加自身观察传输——serve 事件订阅 / run 实时
 * 进度因此能收到全部回合事件，无需复制 host 装配逻辑。
 */

import type { Runtime } from '@ink-ts/engine';
import type { EngineTransport } from '@ink-ts/engine';

/** 往引擎全局传输链追加一个观察传输；返回解挂函数（幂等）。 */
export function attachEngineTransport(
  runtime: Runtime,
  transport: EngineTransport,
): () => void {
  const engine = runtime.engine;
  if (engine === null) return () => undefined;
  const opts = engine as unknown as { options: { transports: EngineTransport[] } };
  const list = opts.options.transports;
  list.push(transport);
  let detached = false;
  return (): void => {
    if (detached) return;
    detached = true;
    const index = list.indexOf(transport);
    if (index >= 0) list.splice(index, 1);
  };
}
