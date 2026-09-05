/**
 * exec 受监督 client：spawn/看护/重启 + 信封签发调用。
 *
 * - 二进制定位走 binary.ts（INK_EXEC_BINARY / INK_NATIVE_DIR / 工作树
 *   target 布局）；spawn 期注入随机会话密钥（INK_EXEC_SESSION_KEY），
 *   信封签名用同一密钥（exec 复核签名的唯一信任源）；
 * - 裁决面门在 envelope.ts：越权/越根/未批准由 host 拒绝（ExecRefused），
 *   进程不触达；exec 侧机械复核为第二道防线；
 * - 崩溃看护/重启/熔断在 SupervisedNativeSession（infer client 与它共用
 *   这一样板，见 host/src/exec/session.ts）。
 */

import type {
  ExecDecision,
  ExecEnvelope,
  ExecOutcome,
  ExecRefusedError,
  RestartPolicy,
  RpcError,
} from './_types.js';
import { buildSignedExecEnvelope, randomSessionKey } from './envelope.js';
import type { AdjudicatedDecision, ExecRequest } from './envelope.js';
import { SupervisedNativeSession } from './session.js';
import type { SessionOpener } from './session.js';

/** exec 会话密钥环境变量名（与 exec crate SESSION_KEY_ENV 对偶）。 */
export const EXEC_SESSION_KEY_ENV = 'INK_EXEC_SESSION_KEY';

/** ExecClient 选项。 */
export interface ExecClientOptions {
  /** exec 二进制路径（binary.ts 定位产物）。 */
  binary: string;
  /** 会话密钥（缺省随机生成；测试可注入固定值）。 */
  sessionKey?: string;
  /** 重启策略（缺省保守值）。 */
  policy?: Partial<RestartPolicy>;
  /** 附加 spawn 环境（宿主侧；密钥自动注入，勿手填同名键）。 */
  env?: Record<string, string> | null;
  cwd?: string;
  /** 会话打开器（测试注入计数/假会话）。 */
  opener?: SessionOpener | null;
  onStderr?: (line: string) => void;
}

/** exec 受监督 client（一次构造 = 一个会话密钥域；重连沿用同密钥）。 */
export class ExecClient {
  readonly sessionKey: string;
  private readonly session: SupervisedNativeSession;

  constructor(options: ExecClientOptions) {
    const key = options.sessionKey ?? randomSessionKey();
    this.sessionKey = key;
    this.session = new SupervisedNativeSession(
      {
        binary: options.binary,
        env: { ...(options.env ?? {}), [EXEC_SESSION_KEY_ENV]: key },
        cwd: options.cwd,
        onStderr: options.onStderr,
      },
      options.policy,
      options.opener ?? null,
    );
  }

  /** 信封调用（裁决面门 → 签名 → 受监督发送）。 */
  async call(request: ExecRequest, decision: AdjudicatedDecision): Promise<ExecOutcome> {
    const signed = buildSignedExecEnvelope(request, decision, this.sessionKey);
    const result = (await this.session.request('exec.call', {
      body: signed.body,
      signature: signed.signature,
    })) as ExecOutcome;
    return result;
  }

  /** 存活探测（崩溃自动拉起后重探一次）。 */
  async healthCheck(): Promise<boolean> {
    return await this.session.healthCheck();
  }

  /** 关停（幂等）。 */
  async close(): Promise<void> {
    await this.session.close();
  }
}

export type {
  AdjudicatedDecision,
  ExecDecision,
  ExecEnvelope,
  ExecOutcome,
  ExecRefusedError,
  ExecRequest,
  RestartPolicy,
  RpcError,
};
