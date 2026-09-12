/**
 * 事件协议常量与错误（计划 §4.1 events 拆分：类型/常量落 model，封套/传输面
 * 在 dock/ports/events.ts——EngineEvent 信封与 EngineTransport 见该端口面）。
 *
 * 协议版本化：PROTOCOL_VERSION = 与前端协议同构的版本常量（前端零改动约束）；
 * 不兼容版本在传输入口拒绝（ProtocolVersionError）。
 *
 * ProtocolVersionError 暂居本模块——收敛至 errors.ts（EngineError 继承面）
 * 待办。
 */

/** 事件协议版本：与前端协议同构（前端零改动约束）。 */
export const PROTOCOL_VERSION = 2;

/** 事件协议版本不兼容（增量演进范围内加字段兼容，破坏性变更需升级版本）。 */
export class ProtocolVersionError extends Error {
  constructor(found: unknown, expected: number) {
    super(`事件协议版本不兼容: found=${found}, expected=${expected}`);
    this.name = 'ProtocolVersionError';
  }
}
