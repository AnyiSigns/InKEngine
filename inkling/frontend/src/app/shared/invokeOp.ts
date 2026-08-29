import { createTauriInvoker, handleEngineError } from '@/shared/backend/tauriBridge';

/**
 * 单命令调用（记忆/知识/洞察等只读面）：统一经 tauriBridge 的传输与
 * 错误信封收口（code/message/trace_id 记日志），宿主不可用/失败返回 null
 * ——排障可循 trace_id 关联本地审计日志，不再静默吞错。
 */
export async function invokeOp<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const invoker = createTauriInvoker();
  if (!invoker) return null;
  try {
    const result = await invoker.invoke(cmd, args);
    return result as T;
  } catch (err) {
    handleEngineError(cmd, err);
    return null;
  }
}
