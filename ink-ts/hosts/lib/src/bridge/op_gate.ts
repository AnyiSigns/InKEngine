/**
 * 宿主命令闸（host 级维护互斥）：backup.restore 属危险替换操作，执行期间
 * 并发 bridge 请求一律拒绝（fail-closed：维护中不静默接受写/读请求，避免
 * 在目录替换的半态窗口读到不一致数据）。buildBridge 对每个方法包装
 * assertIdle；restore handler 在确认标记通过后立即 begin，直到替换+装配
 * 完成才 end。
 */

import { BridgeError } from './_types.js';
import type { HostOpGate } from './_types.js';

/** 维护期间并发请求的归类码（restore 阶段专用）。 */
export const MAINTENANCE_REJECT_CODE = 'restore_in_progress';

export function createHostOpGate(): HostOpGate {
  let op: string | null = null;
  return {
    get op(): string | null {
      return op;
    },
    begin(next: string): void {
      if (op !== null) {
        throw new BridgeError(
          `宿主已有维护操作进行中（${op}）；并发 ${next} 被拒`,
          MAINTENANCE_REJECT_CODE,
        );
      }
      op = next;
    },
    end(): void {
      op = null;
    },
    assertIdle(): void {
      if (op !== null) {
        throw new BridgeError(
          `宿主正在执行 ${op}（数据目录替换期间拒绝并发请求，请稍后重试）`,
          MAINTENANCE_REJECT_CODE,
        );
      }
    },
  };
}
