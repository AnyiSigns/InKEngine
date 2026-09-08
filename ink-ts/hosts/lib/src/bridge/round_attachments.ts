/**
 * rounds 附件载荷归一与文档文本注入（host 侧薄逻辑，可单测）。
 *
 * 语义：web/serve 传入附件载荷 → 归一为引擎 Attachment 数据形态；其中
 * document 附件若有可解析的本地 path，经 doc 执行体（exec doc.parse）
 * 提取文本注入 user 消息（单附件截断上限可配置，超限记 warning）；解析
 * 失败降级文件名引用 + 可见告警。附件本身始终保留（url/path 随载荷入
 * 引擎，供工具取用）。
 */

import type { DocParser } from '../doc/_types.js';

/** 引擎 Attachment 的 kind 白名单（对齐 llm/_shapes ATTACHMENT_KINDS）。 */
const ATTACHMENT_KINDS = new Set(['image', 'video', 'document']);

/** rounds 收到的附件载荷（宽松输入；归一后落引擎数据面）。 */
export interface RoundAttachmentDto {
  kind?: unknown;
  url?: unknown;
  path?: unknown;
  name?: unknown;
  mime?: unknown;
  mime_type?: unknown;
}

/** 归一后的附件载荷（引擎 Attachment 数据面键名）。 */
export interface AttachmentPayload {
  kind: string;
  url: string | null;
  path: string | null;
  mime_type: string | null;
  name: string | null;
}

/** 注入后的回合载荷（input 含文档文本段；warnings 为可见告警）。 */
export interface PreparedRound {
  input: string;
  attachments: AttachmentPayload[];
  warnings: string[];
}

/** 归一单个附件载荷；形态非法（未知 kind / 无 url 与 path）返回 null。 */
export function normalizeAttachment(raw: unknown): AttachmentPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const dto = raw as RoundAttachmentDto;
  const kind = typeof dto.kind === 'string' ? dto.kind : '';
  if (!ATTACHMENT_KINDS.has(kind)) return null;
  const url = typeof dto.url === 'string' && dto.url !== '' ? dto.url : null;
  const path = typeof dto.path === 'string' && dto.path !== '' ? dto.path : null;
  if (url === null && path === null) return null;
  const mimeType =
    (typeof dto.mime_type === 'string' && dto.mime_type !== '' ? dto.mime_type : null) ??
    (typeof dto.mime === 'string' && dto.mime !== '' ? dto.mime : null);
  return {
    kind,
    url,
    path,
    mime_type: mimeType,
    name: typeof dto.name === 'string' && dto.name !== '' ? dto.name : null,
  };
}

export interface RoundDocDeps {
  docParse?: DocParser;
  /** 授权根（附件目录）；缺省 = 不解析文档（仅文件名引用语义）。 */
  attachmentDir?: string;
  /** 单附件文本注入上限（null/缺省 = 执行体构造缺省）。 */
  docTextCap?: number | null;
}

/**
 * 归一附件 + 文档文本注入，产出回合载荷。
 *
 * 文档注入：path 且解析器齐备 → doc.parse 提取文本注入 input；解析失败
 * 或执行体不可用 → input 追加「仅附文件名引用」段 + warnings（可见告警）。
 */
export async function prepareRoundInput(
  input: string,
  raws: unknown,
  deps: RoundDocDeps,
): Promise<PreparedRound> {
  const attachments: AttachmentPayload[] = [];
  const warnings: string[] = [];
  const segments: string[] = [];
  const items = Array.isArray(raws) ? raws : [];
  for (const raw of items) {
    const attachment = normalizeAttachment(raw);
    if (attachment === null) {
      warnings.push('附件项形态非法已忽略（须含 kind 且 url/path 至少其一）');
      continue;
    }
    attachments.push(attachment);
    const label = attachment.name ?? attachment.path ?? attachment.url ?? attachment.kind;
    const path = attachment.path;
    if (attachment.kind !== 'document' || path === null) continue;
    if (deps.docParse === undefined || deps.attachmentDir === undefined || deps.attachmentDir === '') {
      continue;
    }
    const result = await deps.docParse.parseDocument(
      path,
      deps.attachmentDir,
      deps.docTextCap ?? undefined,
    );
    if (!result.ok) {
      warnings.push(`附件 ${label} 文档解析失败（${result.code}）：仅附文件名引用`);
      segments.push(`[附件 ${label}：文档内容解析失败，仅附文件名引用]`);
      continue;
    }
    const text = result.text.trim();
    if (text === '') {
      warnings.push(`附件 ${label} 文档解析结果为空，仅附文件名引用`);
      continue;
    }
    if (result.truncated) {
      warnings.push(`附件 ${label} 文档文本超注入上限，已截断`);
    }
    segments.push(`[文档附件 ${label}]\n${text}`);
  }
  const finalInput =
    segments.length > 0 ? `${input}\n\n${segments.join('\n\n')}` : input;
  return { input: finalInput, attachments, warnings };
}
