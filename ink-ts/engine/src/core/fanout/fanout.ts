/**
 * fan_out 并行原语（fanout.py 移植）：并发执行一组任务，替代裸 Promise.all。
 *
 * 语义（部分失败剔除）：并行执行任务（limit 限流并发），普通失败剔除、
 * 成功结果保留，并行容错在引擎层统一。propagate 指定的控制流异常不做剔除
 * 而是传播——传播时取消全部未完成兄弟任务后上抛（防父流程已收尾、兄弟任务
 * 仍滞留后台写链/写事件的泄漏与存储竞态）。
 *
 * 结果形态：
 * - successes 保持输入下标顺序；success_indices 与 successes 对齐记录原始
 *   下标（剔除后仍可定位来源）；failures 含剔除原因（按 index 升序）。
 * - 哨兵区分「未成功（剔除/未跑）」与「合法返回 null/undefined」——成功值
 *   一律保留并维持下标对齐（None 是合法结果，直接按空值过滤会静默吞掉）。
 *
 * TS seam 差异（异步语义的界面表达，语义对齐以 Python 实际行为为准）：
 * - JS 无 BaseException/Exception 层级，也无运行时注入的 CancelledError：
 *   剔除边界以 propagate 名单为准，名单外一律按普通失败剔除（等价 Python
 *   侧 `except Exception` 的消化面）；传播即取消全部未完成兄弟任务后上抛。
 * - 兄弟取消经共享 AbortSignal 注入任务工厂第二参表达：任务在内部 await 点
 *   监听即可协作退出（类比 asyncio 在任意 await 点注入 CancelledError）；
 *   不监听 signal 的任务无法被强行中断，其迟滞完成/失败一律丢弃不记录
 *   （Python 取消后同样不再入结果、不再记失败）。
 * - logger.warning 留痕属可观测性副作用，TS core 零 IO 不落。
 * - 非法并发上限抛 RangeError（Python ValueError 按既有移植口径映射，
 *   见 patch_chain 的裁剪点越界先例）。
 *
 * 已知边界（多径/子图展开的中断收口场景）：JS 无协作取消，传播（propagate）
 * 取消只对监听 AbortSignal 的兄弟任务生效——不监听的任务可能继续在途运行，
 * 其事件写入可能落后于调用方已落定的终态 checkpoint；若该在途任务属于带
 * checkpoint 子链的展开（spawn/推演分支/多径支流），resume 重放该子链时可能
 * 携带这批「迟到事件」。消费方（恢复解析/审计）须容忍重放集为超集；需要
 * 协作退出的任务应在内部 await 点监听注入的 AbortSignal。
 */

/** 哨兵：仅标记「未成功（剔除/未跑）」，区别于合法的 null/undefined 成功值。 */
const UNSET = Symbol('fan_out.unset');

type Slot<T> = T | typeof UNSET;

/** 可传播的控制流异常类（propagate 名单成员，传播时取消兄弟任务）。 */
export type ErrorClass = abstract new (...args: any[]) => Error;

/** fan_out 关键字选项（镜像 Python 的 keyword-only 参数 propagate）。 */
export interface FanOutOptions {
  /** 不做剔除、直接传播的控制流异常类型（缺省无；单类或类列表）。 */
  propagate?: ErrorClass | readonly ErrorClass[];
}

/** 任务工厂：接收自身索引（并行项编号注入），返回本项异步结果。 */
export type FanOutTask<T> = (index: number, signal: AbortSignal) => Promise<T>;

/** 单任务失败信息（剔除原因留痕，供消费方展示）。 */
export class FanOutFailure {
  readonly index: number;
  readonly error: string;

  constructor(index: number, error: string) {
    this.index = index;
    this.error = error;
  }
}

/** 并行结果：成功值按输入顺序 + 失败剔除清单。 */
export class FanOutResult<T = unknown> {
  successes: T[] = [];
  failures: FanOutFailure[] = [];
  success_indices: number[] = [];

  get all_succeeded(): boolean {
    return this.failures.length === 0;
  }
}

function normalizePropagate(
  propagate: ErrorClass | readonly ErrorClass[] | undefined,
): readonly ErrorClass[] {
  if (propagate === undefined) return [];
  if (typeof propagate === 'function') return [propagate];
  return propagate;
}

function isPropagateError(err: unknown, types: readonly ErrorClass[]): boolean {
  if (types.length === 0) return false;
  if (!(err instanceof Error)) return false;
  for (const cls of types) {
    if (err instanceof (cls as unknown as Function)) return true;
  }
  return false;
}

/** 取失败留痕文本（镜像 Python str(exc)：Error 取 message，其余字符串化）。 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function buildResult<T>(
  values: readonly Slot<T>[],
  failures: readonly FanOutFailure[],
): FanOutResult<T> {
  const successes: T[] = [];
  const success_indices: number[] = [];
  values.forEach((value, index) => {
    if (value === UNSET) return;
    successes.push(value);
    success_indices.push(index);
  });
  const ordered = [...failures].sort((a, b) => a.index - b.index);
  const result = new FanOutResult<T>();
  result.successes = successes;
  result.failures = ordered;
  result.success_indices = success_indices;
  return result;
}

/**
 * 并发执行任务列表，部分失败剔除（Promise.all + return_exceptions 语义）。
 *
 * 调度为有界并发池：同时至多 limit 项在途，完成一项才启动下一项（与
 * Python 侧 Semaphore FIFO 让位次序一致）；某任务抛 propagate 控制流异常
 * 即中止调度：abort 共享信号（协作任务据此退出）、丢弃其余在途/未启动
 * 兄弟的结果后原样上抛。
 */
export function fan_out<T>(
  tasks: readonly FanOutTask<T>[],
  limit: number,
  options: FanOutOptions = {},
): Promise<FanOutResult<T>> {
  if (limit <= 0) {
    return Promise.reject(new RangeError(`fan_out 并发上限必须为正: ${limit}`));
  }
  if (tasks.length === 0) {
    return Promise.resolve(new FanOutResult<T>());
  }
  const propagateTypes = normalizePropagate(options.propagate);
  return new Promise<FanOutResult<T>>((resolveOuter, rejectOuter) => {
    const values: Slot<T>[] = new Array<Slot<T>>(tasks.length);
    values.fill(UNSET);
    const failures: FanOutFailure[] = [];
    const controller = new AbortController();
    let next = 0;
    let running = 0;
    let aborted = false;
    let settled = false;

    const runTask = async (index: number): Promise<void> => {
      try {
        const value = await tasks[index]!(index, controller.signal);
        if (!aborted) values[index] = value;
      } catch (err) {
        if (aborted) return;
        if (isPropagateError(err, propagateTypes)) {
          aborted = true;
          settled = true;
          controller.abort();
          rejectOuter(err);
          return;
        }
        failures.push(new FanOutFailure(index, errorText(err)));
      } finally {
        running -= 1;
        if (!aborted && !settled) pump();
      }
    };

    const pump = (): void => {
      if (aborted || settled) return;
      while (running < limit && next < tasks.length) {
        const index = next;
        next += 1;
        running += 1;
        void runTask(index);
      }
      if (running === 0 && next === tasks.length) {
        settled = true;
        resolveOuter(buildResult(values, failures));
      }
    };

    pump();
  });
}
