/**
 * 环境提供器协议与环境审计存储契约（environments.py 的 Protocol 面移植）。
 *
 * EnvironmentProvider 为机制接口（按声明提供/销毁/运行环境）：ensure 幂等
 * （已就绪返回既有实例）、destroy 幂等（已销毁静默成功）、run 仅执行白名单
 * 命令（沙箱 fail-closed）。EnvAuditStorage 取 Storage 接口的 put_record 面
 * （duck-typed 最小契约；宿主完整 Storage 亦满足）。
 */
import type { ProcessResult } from '../sandbox/index.js';

import type { EnvironmentHandle, EnvironmentSpec } from './spec.js';

/** 环境审计落库的最小契约：put_record 单方法面。 */
export interface EnvAuditStorage {
  put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void>;
}

/** 环境提供器接口（机制：按声明提供/销毁/运行环境）。 */
export interface EnvironmentProvider {
  readonly name: string;
  ensure(spec: EnvironmentSpec): Promise<EnvironmentHandle>;
  destroy(handle: EnvironmentHandle): Promise<void>;
  run(handle: EnvironmentHandle, command: string, args?: readonly string[]): Promise<ProcessResult>;
}
