/**
 * 进程内异步互斥锁（镜像 Python asyncio.Lock；adapters 层收敛单文件）。
 *
 * mcp/supervised（会话调用串行化）与 storage/_base（内存后端读写串行化）
 * 原各自携带一份实现（supervised 旧 AsyncLock 与 storage/_mutex），现收敛为
 * 基础面（storage 用），acquire_run 为 tail 链别名（mcp 用）——两种调用
 * 面语义一致（FIFO，等待者间转移不落空：release 总是唤醒下一位，仅无
 * 等待者时解锁）。
 */

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

  /** 整体持锁执行（finally 释放；镜像 Python ``async with lock``）。 */
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** tail 链别名（mcp/supervised 的既有调用面；语义与 run 相同）。 */
  async acquire_run<T>(fn: () => Promise<T>): Promise<T> {
    return await this.run(fn);
  }
}
