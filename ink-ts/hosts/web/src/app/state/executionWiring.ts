/**
 * execution.run 回执接线（W7E web 消费主线）：桥命令回执 → 会话执行树落位。
 *
 * 壳侧动作面（非显示设备）：调用宿主 execution.run（backendAdapter.executionRun），
 * 回执经显示设备镜像契约解析（parseExecutionReceipt，形态非法 = 显式拒绝不落位），
 * 成功落进发起窗口对应会话桶（ingestExecutionReceipt；设备执行树卡经
 * state.executionRuns 绑定通道消费 run 树/事件投影）。失败与发送回合同口径：
 * 错误落回发起线程消息流（appendRoundError），不静默吞错。
 *
 * execution.run 命令面无 thread 参数（引擎执行树以 run_id 自持）；回执归属 =
 * 发起时刻的活动会话窗口（切窗不误投，后台窗口收不到当前窗口的执行落位）。
 */

import { useCallback } from 'react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { ChannelHub } from '@/shared/session/channelHub';
import type { ExecutionReceipt, ExecutionRunParams } from '@/shared/session/executionTypes';
import { parseExecutionReceipt } from '@/shared/session/executionTypes';
import { ingestExecutionReceipt } from '@/shared/session/executionIngest';
import { appendRoundError } from '@/shared/session/eventIngest';
import { logger } from '@/shared/logger';

/** 执行下发结果（receipt = 落位回执；error = 用户可见失败细节）。 */
export interface ExecutionRunOutcome {
  ok: boolean;
  receipt: ExecutionReceipt | null;
  error: string | null;
}

/** 回执形态非法（宿主版本漂移兜底）；错误经 appendRoundError 上屏。 */
export async function dispatchExecutionRun(
  hub: ChannelHub,
  backend: BackendAdapter,
  threadId: string,
  params: ExecutionRunParams,
): Promise<ExecutionRunOutcome> {
  if (!backend.available) {
    return { ok: false, receipt: null, error: '宿主后端不可用' };
  }
  try {
    const raw = await backend.executionRun(params);
    const receipt = parseExecutionReceipt(raw);
    if (receipt === null) {
      appendRoundError(hub, threadId, '执行回执形态非法（宿主版本漂移？）');
      logger.warn('app', 'execution.run 回执形态非法，未落位', { threadId });
      return { ok: false, receipt: null, error: '执行回执形态非法' };
    }
    ingestExecutionReceipt(hub, threadId, receipt);
    return { ok: true, receipt, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? '执行运行失败');
    appendRoundError(hub, threadId, `执行运行失败：${message}`);
    logger.warn('app', 'execution.run 下发失败', { threadId, err: message });
    return { ok: false, receipt: null, error: message };
  }
}

/** React 消费面：runExecution（活动窗口归属 + pose 透传由壳调用侧定）。 */
export function useExecutionRunDispatch(
  hub: ChannelHub,
  backend: BackendAdapter,
): (threadId: string, params: ExecutionRunParams) => Promise<ExecutionRunOutcome> {
  return useCallback(
    (threadId: string, params: ExecutionRunParams) => dispatchExecutionRun(hub, backend, threadId, params),
    [hub, backend],
  );
}
