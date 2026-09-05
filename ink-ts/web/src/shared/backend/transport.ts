/**
 * 前端宿主通道抽象（serve transport stub）：web 与引擎宿主之间唯一传输面。
 *
 * 形态随迁自旧侧前端的 transport 分界：宿主交互 = request(method, params)；
 * 事件流 = subscribe(topic, handler)。桌面 IPC 假设整体移除：生产通道 =
 * cli serve http/ws，本文件 = **接口契约 + serve 就绪前 stub**
 * （available=false）。serve 落地时经 `setServeChannel` 注入真 transport，
 * 后端适配器与视图零改动。
 *
 * - request 方法命名 = 引擎/宿主域方法（round_send / session_list / todo.get /
 *   ui_spec.apply / knowledge.list 等，与 host bridge 域命名
 *   rounds.* 、records.* 、approval.* 、audit.* 的映射注释见 backendAdapter
 *   命令面），serve 侧按宿主命令面映射；
 * - subscribe 事件 topic = ROUND_EVENT_TOPIC（引擎回合事件信封流：payload 为
 *   {type, thread_id, round_id, step_id, …}，经 app/activate 归约进 ChannelHub）；
 *   serve 侧的 state.* / events.* 细分通道由真 transport 实现承载本单一订阅；
 * - 错误信封 {code, message, trace_id}：前端只收错误信封不进细节，细节走
 *   serve diag 面。
 */

import { logger } from '@/shared/logger';

/** 统一错误信封形态（后端 {code, message, trace_id}）。 */
export interface EngineErrorEnvelope {
  code?: string;
  message?: string;
  trace_id?: string;
}

/** 统一命令失败处理（单通道面的错误收口）：
 * 提取 {code, message, trace_id} 记入日志后原样上抛——backendAdapter /
 * settings 全部命令调用共用此面，不再各自 catch 静默吞错或丢 trace_id。 */
export function handleEngineError(cmd: string, err: unknown): void {
  const envelope = (err ?? {}) as EngineErrorEnvelope;
  logger.warn('engine', `命令失败: ${cmd}`, {
    code: envelope.code ?? 'UNKNOWN',
    message: envelope.message ?? String(err),
    trace_id: envelope.trace_id ?? '',
  });
}

/** 宿主通道接口（cli serve http/ws 传输契约；真实现按本接口经 setServeChannel 注入）。 */
export interface ServeChannel {
  /** 通道可用性（false = serve 未连接/未就绪，调用方回落夹具路径）。 */
  available: boolean;
  /** serve http 基址（真通道注入时填写；stub 不填）。 */
  baseUrl?: string;
  /** 请求宿主方法（JSON-RPC 信封形态由 serve 承载；错误信封归一上抛）。 */
  request<T>(method: string, params?: unknown): Promise<T>;
  /** 订阅事件 topic（serve 推送；返回注销函数，宿主不可用返回空操作）。 */
  subscribe(topic: string, handler: (payload: unknown) => void): Promise<() => void>;
}

/** 事件信封载荷（serve 推送回调控件形态）。 */
export interface ServeEventEnvelope<T> {
  event: string;
  id: number;
  payload: T;
}

/** 引擎回合事件流订阅 topic（web 侧单一订阅；serve 事件面唯一入口）。 */
export const ROUND_EVENT_TOPIC = 'round_event';

/** serve 端点解析环境键（dev/集成期预置；如 http://127.0.0.1:8010）。 */
export const SERVE_URL_ENV_KEY = 'VITE_SERVE_URL';

/** 通道未就绪的 stub：available=false，请求一律显式拒绝（不静默假成功）。 */
export function createUnavailableChannel(): ServeChannel {
  const unavailable = (): never => {
    throw new Error('宿主 serve 通道未就绪（web transport stub；cli serve 就绪后经 setServeChannel 接入）');
  };
  return {
    available: false,
    request: unavailable as never,
    subscribe: async () => () => undefined,
  };
}

/** 由环境解析 serve 通道：未配置 VITE_SERVE_URL = stub（当前默认形态）。 */
export function resolveServeChannel(env?: { [SERVE_URL_ENV_KEY]?: string }): ServeChannel {
  const url = env?.[SERVE_URL_ENV_KEY];
  if (!url) return createUnavailableChannel();
  // 真通道实现（request → HTTP JSON-RPC，subscribe → WebSocket 事件订阅）
  // 在此落位；serve 通道注入前不在此硬编码传输细节。
  return createUnavailableChannel();
}

let serveChannel: ServeChannel = createUnavailableChannel();

/** 注入真 serve 通道（装配期/集成测试调用一次；未注入 = stub 默认）。 */
export function setServeChannel(channel: ServeChannel): void {
  serveChannel = channel;
}

/** 当前生效的 serve 通道（backendAdapter 装配与事件订阅共用同一实例）。 */
export function getServeChannel(): ServeChannel {
  return serveChannel;
}

/** 订阅宿主事件流（经 serve 通道；事件名如 ROUND_EVENT_TOPIC；通道不可用
 * 返回空操作，调用方回落夹具路径）。 */
export async function listenHostEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!serveChannel.available) return () => undefined;
  return serveChannel.subscribe(event, (raw) => {
    const typed = raw as ServeEventEnvelope<T>;
    handler(typed?.payload ?? (raw as T));
  });
}
