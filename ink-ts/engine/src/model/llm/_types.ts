/**
 * LLM 层数据形态共享类型与常量（errors.ts / messages.ts / tools.ts 复用）。
 *
 * 角色枚举与附件类别作为不可变 Set 暴露：构造期校验与适配器收敛形态共用
 * 同一份事实源，避免「字符串散落 → 多处漂移」。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export const ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool']);

/** 角色别名归一（human/ai 命名 → 引擎规范角色）。 */
export const ROLE_ALIASES: Readonly<Record<string, string>> = {
  human: 'user',
  ai: 'assistant',
};

export type AttachmentKind = 'image' | 'video' | 'document';

export const ATTACHMENT_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'document']);

/** 附件 → OpenAI 兼容内容段 type（image/video/document → <kind>_url）。 */
export const ATTACHMENT_SEGMENT_TYPES: Readonly<Record<string, string>> = {
  image: 'image_url',
  video: 'video_url',
  document: 'document_url',
};