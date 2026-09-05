/**
 * 事件落文件传输（D9：结构化事件落文件实时刷新，不靠日志打印）。
 *
 * 每个传输实例对单个 JSONL 事件文件 append：send 事件即序列化一行并等待
 * 底层写回调（写入 + 落盘均经 stream 写队列）——事件到达即持久化，供
 * 前端/审计/恢复侧以文件形式实时查（observability 约束：有点查=差，文件
 * 可查）。缓冲保留引擎事件引用（观测面；与 CollectorTransport 同风格），
 * send 失败不抛给引擎（观测不阻断执行：引擎 _deliver_event 已逐条容错，
 * 此处文件写失败以行级错误吞并并记 last_error，宿主可检）。
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import type { EngineEvent, EngineTransport } from '@ink-ts/engine';

/** JSONL 事件文件传输（EngineTransport 实现；close 幂等）。 */
export class FileEventsTransport implements EngineTransport {
  readonly filePath: string;
  readonly events: EngineEvent[] = [];
  private _stream: WriteStream | null = null;
  private _closed = false;
  lastError: Error | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** 懒开写流（首事件到达时；append 模式不覆盖历史）。 */
  private _ensure(): WriteStream {
    if (this._stream === null) {
      const stream = createWriteStream(this.filePath, { flags: 'a' });
      stream.on('error', (error) => {
        this.lastError = error;
      });
      this._stream = stream;
    }
    return this._stream;
  }

  async send(event: EngineEvent): Promise<void> {
    if (this._closed) return;
    this.events.push(event);
    const stream = this._ensure();
    const line = `${JSON.stringify(event.to_dict())}\n`;
    // 等待写回调 = 行级落盘后再返回（事件实时刷文件）
    await new Promise<void>((resolve) => {
      if (stream.write(line, () => resolve())) return;
      // write 返回 false 只表示背压，回调仍会触发；此处无需额外处理
    });
  }

  /** 幂等关停：flush + 关闭文件流（宿主 dispose/测试收尾调用）。 */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    const stream = this._stream;
    this._stream = null;
    if (stream === null) return;
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
}
