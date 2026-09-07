/**
 * doc_parse 插件 logic face —— 阶段 7a 首个真实 host logic face 样板。
 *
 * 语义：经 exec 原生件（op=doc，file 端点）做文档文本提取；host 装配期由
 * host/src/face/loader.ts 按 spec faces.logic.entry 动态装载（真源 =
 * plugins/tools/doc_parse/spec.json，目标态=按 target 切的条件导出）。
 * 越权/越根由 exec 信封的 host 裁决面门拒绝；二进制未装配 = exec_unavailable
 * 结构化返回（round/material 消费方走降级路径），不抛。
 */

import { ExecClient, locateNativeBinary } from '@ink-ts/host';
import type { DocParseResult, DocParser } from '@ink-ts/host';

/** 单附件文本注入缺省上限（字符；rounds 逐附件截断；env/装配可覆盖）。 */
export const DEFAULT_DOC_TEXT_CAP = 20000;

export interface DocServiceOptions {
  /** exec 二进制路径（缺省 = binary.ts 按声明定位；null = 视为未装配）。 */
  binary?: string | null;
  /** 输出文本截断上限（缺省见 DEFAULT_DOC_TEXT_CAP）。 */
  maxChars?: number;
}

/** exec 文档解析执行体（DocParser 实现；随插件同住）。 */
export class DocService {
  private readonly binary: string | null;
  private readonly maxChars: number;

  constructor(options: DocServiceOptions = {}) {
    this.binary = options.binary !== undefined ? options.binary : locateNativeBinary('exec');
    this.maxChars = options.maxChars ?? DEFAULT_DOC_TEXT_CAP;
  }

  /** exec 原生二进制是否可用（不可用 = 一律 exec_unavailable 降级）。 */
  available(): boolean {
    return this.binary !== null && this.binary !== '';
  }

  /** 解析文档（根内路径；失败结构化返回）。 */
  async parseDocument(path: string, root: string, maxChars?: number): Promise<DocParseResult> {
    if (!this.available()) {
      return {
        ok: false,
        code: 'exec_unavailable',
        message: 'doc 解析器未装配：未定位 exec 原生二进制（先 cargo build ink-ts/exec）',
      };
    }
    const client = new ExecClient({ binary: this.binary! });
    try {
      const outcome = await client.call(
        { tool: 'doc_parse', op: 'doc', args: { subop: 'parse', path } },
        {
          approved: true,
          by: 'host:doc.parse',
          trace_id: null,
          endpoint: 'file',
          roots: [root],
          allowlist: [],
          timeout_secs: 120,
          max_chars: maxChars ?? this.maxChars,
        },
      );
      const output = outcome.output as {
        format?: unknown;
        text?: unknown;
        page_count?: unknown;
        truncated?: unknown;
      };
      const format = output['format'];
      const text = output['text'];
      if (typeof format !== 'string' || typeof text !== 'string') {
        return { ok: false, code: 'bad_result', message: 'doc.parse 返回形态非法' };
      }
      const pageCount = output['page_count'];
      return {
        ok: true,
        format,
        text,
        page_count: typeof pageCount === 'number' ? pageCount : null,
        truncated: output['truncated'] === true,
      };
    } catch (error) {
      return {
        ok: false,
        code: failureCode(error),
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await client.close();
    }
  }
}

/** 装配注入入口：loader 把每个 host logic face 的默认导出视为统一工厂
 *  (init?: unknown) => 实例——插件自有契约（init 形状由其 spec/AGENTS 定义），
 *  loader 只装载不解析。 */
export default function createDocService(options: DocServiceOptions = {}): DocService {
  return new DocService(options);
}

function failureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'reason' in error) {
    const reason = (error as { reason?: unknown })['reason'];
    if (typeof reason === 'string' && reason !== '') return reason;
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown })['code'];
    if (typeof code === 'string' && code !== '') return code;
  }
  return 'doc_error';
}
