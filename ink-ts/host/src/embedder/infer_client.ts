/**
 * infer 受监督 client（复用 exec client 的 spawn/看护/重启样板）。
 *
 * infer 是本地嵌入推理子进程（granite-97m；env 覆盖与确定性保底在进程
 * 内语义自洽——宿主按 INK_EMBEDDING_* 决定是否值得拉起它）。本类只做
 * 三件协议事：infer.plan（计划解析）、infer.embed（texts → vectors +
 * source/dim/note）、ping；监督/重启/熔断全部经 SupervisedNativeSession。
 */

import type { RestartPolicy } from '../exec/_types.js';
import type { SessionOpener } from '../exec/session.js';
import { SupervisedNativeSession } from '../exec/session.js';
import type { EmbeddingSourceName } from './resolve_plan.js';

/** infer.plan 响应（wire）。 */
export interface InferPlanWire {
  source: EmbeddingSourceName;
  dim: number;
  note: string | null;
  remote: { base_url: string; model_id: string; adapter: string } | null;
}

/** infer.embed 响应（wire）。 */
export interface InferEmbedWire {
  source: EmbeddingSourceName;
  dim: number;
  note: string | null;
  vectors: number[][];
}

/** InferClient 选项。 */
export interface InferClientOptions {
  /** infer 二进制路径（binary.ts 定位产物）。 */
  binary: string;
  /** spawn 附加环境（如 INK_EMBEDDING_MODEL_DIR / INK_EMBEDDING_LOCAL）。 */
  env?: Record<string, string> | null;
  cwd?: string;
  policy?: Partial<RestartPolicy>;
  /** 会话打开器（测试注入）。 */
  opener?: SessionOpener | null;
  onStderr?: (line: string) => void;
}

/** 单次 embed 文本条数上界（与 infer crate 协议对偶）。 */
export const EMBED_TEXTS_MAX = 256;

/** infer 受监督 client。 */
export class InferClient {
  private readonly session: SupervisedNativeSession;

  constructor(options: InferClientOptions) {
    this.session = new SupervisedNativeSession(
      {
        binary: options.binary,
        env: options.env ?? null,
        cwd: options.cwd,
        onStderr: options.onStderr,
      },
      options.policy,
      options.opener ?? null,
    );
  }

  /** 当前嵌入计划（来源/维度/降级原因；懒触发进程内解析）。 */
  async plan(): Promise<InferPlanWire> {
    return (await this.session.request('infer.plan', {})) as InferPlanWire;
  }

  /** 批量嵌入（texts → vectors；保底/远端/本地路由在 infer 进程内）。 */
  async embed(texts: readonly string[]): Promise<InferEmbedWire> {
    if (texts.length === 0) {
      throw new Error('infer.embed texts 不能为空');
    }
    if (texts.length > EMBED_TEXTS_MAX) {
      throw new Error(`infer.embed texts 条数超限（≤${EMBED_TEXTS_MAX}）`);
    }
    return (await this.session.request('infer.embed', { texts: [...texts] })) as InferEmbedWire;
  }

  /** 存活探测。 */
  async healthCheck(): Promise<boolean> {
    return await this.session.healthCheck();
  }

  /** 关停（幂等）。 */
  async close(): Promise<void> {
    await this.session.close();
  }
}
