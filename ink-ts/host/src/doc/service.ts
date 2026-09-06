/**
 * host doc 解析执行体：经 exec 原生件（op=doc）做文档文本提取。
 *
 * 语义：每次调用现拉起受监督 exec 会话（同 os/runner 形态），信封裁决 =
 * host 侧（approved + 根内路径复核在 exec/envelope gateCoverage），exec 只
 * 收已批准信封做机械复核 + 解析。二进制未装配 = exec_unavailable（fail
 * 结构返回，不抛——round 注入走降级路径）。
 */

import { ExecClient } from '../exec/client.js';
import { locateNativeBinary } from '../exec/binary.js';
import type { DocParseResult } from './_types.js';

/** 单附件文本注入缺省上限（字符；rounds 逐附件截断；env 可覆盖）。 */
export const DEFAULT_DOC_TEXT_CAP = 20000;

export interface DocServiceOptions {
  /** exec 二进制路径（缺省 = binary.ts 定位；null = 视为未装配）。 */
  binary?: string | null;
  /** 输出文本截断上限（缺省见 DEFAULT_DOC_TEXT_CAP）。 */
  maxChars?: number;
}

/** exec 文档解析执行体（DocParser 实现）。 */
export class DocService {
  private readonly binary: string | null;
  private readonly maxChars: number;

  constructor(options: DocServiceOptions = {}) {
    this.binary = options.binary ?? locateNativeBinary('exec');
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
