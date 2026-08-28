import { createTauriInvoker } from '@/shared/backend/tauriBridge';

export async function invokeOp<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const invoker = createTauriInvoker();
  if (!invoker) return null;
  try {
    const result = await invoker.invoke(cmd, args);
    return result as T;
  } catch {
    return null;
  }
}
