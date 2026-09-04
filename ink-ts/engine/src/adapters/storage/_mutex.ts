/**
 * 进程内互斥锁（镜像 Python asyncio.Lock）。内存存储后端全部读写经锁
 * 串行化：asyncio 单线程下裸读不炸，但与链尾推进/删除/恢复并发的读会
 * 命中半更新态（对象替换非原地），与 Python 内存端同口径持锁读写——
 * checkpoint 链一致性校验、乐观锁判定与链尾指针推进在临界区内原子。
 *
 * 锁在等待者间转移时不落空：release 总是唤醒下一位，仅无等待者时解锁。
 */

/** 互斥锁：acquire 串行化临界区，release 唤醒下一位（FIFO）。 */
export class AsyncLock {
  #held = false;
  #waiters: Array<() => void> = [];

  /** 获取锁（已锁则排队；返回即可进入临界区）。 */
  acquire(): Promise<void> {
    if (!this.#held) {
      this.#held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /** 释放锁：唤醒下一位等待者；无等待者 = 解锁。 */
  release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.#held = false;
  }

  /** 镜像 Python ``async with lock``：整体持锁执行，finally 释放。 */
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
