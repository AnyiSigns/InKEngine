/**
 * host 原生机制件（exec/infer）连接与信封的共享数据形态。
 *
 * 信封 = host 裁决结果下发给 exec 的机器可读授权：工具名/物理 op/端点归属/
 * 路径根与动态挂载根/命令白名单/出网域名白名单/尺寸与超时上界全部随请求
 * 现取，exec 侧零声明表只复核。裁决判定（approval/auto_allow）属引擎侧
 * 机制（host 只接线），本模块只承载数据结构与协议的 TS 面。
 */

/** 物理执行体族（exec 端点归属的机械形态）。 */
export type ExecOp = 'process' | 'file' | 'http';

/** 裁决元信息（host 侧审批/自动放行的留痕；exec 只要求 approved=true）。 */
export interface ExecDecision {
  approved: boolean;
  /** 裁决来源（如 auto_allow / approval；记录用途，exec 不判定）。 */
  by: string;
  trace_id?: string | null;
}

/** 授权信封本体（JSON 线协议 = 此对象的紧凑序列化文本）。 */
export interface ExecEnvelope {
  version: 1;
  id: string;
  tool: string;
  op: ExecOp;
  args: Record<string, unknown>;
  endpoint: string;
  roots: string[];
  allowlist: string[];
  allow_domains: string[];
  cwd: string | null;
  env: Record<string, string> | null;
  timeout_secs: number;
  max_chars: number;
  nonce: string;
  issued_at: number;
  decision: ExecDecision;
}

/** 签名信封（body 为签名与执行对象的同一串文本）。 */
export interface SignedEnvelope {
  body: string;
  signature: string;
  envelope: ExecEnvelope;
}

/** exec.call 成功结果（output 为 op 专属结果）。 */
export interface ExecOutcome {
  tool: string;
  op: string;
  endpoint: string;
  output: Record<string, unknown>;
}

/** 原生二进制定位种类（exec OS 执行器 / infer 本地嵌入推理）。 */
export type NativeBinaryKind = 'exec' | 'infer';

/** JSON-RPC 协议错误（业务失败 = server 已受理并返回 error，不视为崩溃）。 */
export class RpcError extends Error {
  readonly code: number;
  readonly reason: string | null;
  readonly data: Record<string, unknown> | null;

  constructor(code: number, message: string, reason: string | null = null, data: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.reason = reason;
    this.data = data;
  }
}

/** 宿主侧门拒绝（越权/越根/未批准——host 裁决面，进程未触达）。 */
export class ExecRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecRefusedError';
  }
}

/** 会话失效类错误（进程崩溃/IO 断流；监督层按此判定是否走拉起）。 */
export class SessionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLostError';
  }
}

/** stdio 进程重启策略（镜像 engine adapters/mcp StdioRestartPolicy 保守缺省）。 */
export interface RestartPolicy {
  /** 单次崩溃拉起尝试次数。 */
  max_retries: number;
  /** 拉起间隔退避秒数。 */
  backoff: number;
  /** 连续「重试耗尽」次数达此值 = 熔断打开（fail-closed 拒绝调用）。 */
  circuit_break_threshold: number;
}

/** 缺省重启策略（保守安全值：2 次尝试 / 1s 退避 / 3 次熔断）。 */
export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  max_retries: 2,
  backoff: 1.0,
  circuit_break_threshold: 3,
};
