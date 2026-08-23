/**
 * 媒体白名单策略（附件进入消息流前的校验层）。
 *
 * 三类校验：类型白名单（图片/视频/文档扩展名与 MIME）、大小上限、
 * 路径白名单（视频等本地资源必须位于允许的附件目录前缀下）。
 * 拒绝理由统一输出，组件侧渲染「已拒绝」占位，绝不静默丢弃。
 *
 * 纯函数 + 可注入前缀（测试注入空/越权前缀断言拒绝路径）。
 */

export type ClassifiedKind = 'image' | 'video' | 'document' | 'other';

export interface MediaAssetInput {
  name: string;
  mime?: string;
  size?: number;
  /** 文件选择入口的本地位居路径（本地资源校验用） */
  path?: string;
}

export type MediaVerdict =
  | { ok: true; kind: ClassifiedKind }
  | { ok: false; reason: string };

export const IMAGE_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

export const VIDEO_MIME = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
] as const;

export const DOCUMENT_MIME = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export const MEDIA_EXTENSION_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** 大小上限（字节）：图片 8MB / 视频 100MB / 文档 20MB。 */
export const MEDIA_SIZE_LIMITS = {
  image: 8 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  document: 20 * 1024 * 1024,
} as const;

/** 默认路径白名单前缀（本地附件目录；集成期经宿主注入扩展）。 */
export const DEFAULT_PATH_ALLOWLIST = [
  '~/inkling/attachments',
  '~/.inkling/attachments',
  '/tmp/inkling',
] as const;

/** 规范化本地路径（消除 ./ 与尾部斜杠差异）。 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 路径是否位于白名单前缀之下（越权即拒）。 */
export function isPathAllowed(path: string, allowlist: readonly string[] = DEFAULT_PATH_ALLOWLIST): boolean {
  const normalized = normalizePath(path);
  return allowlist.some((prefix) => normalized === normalizePath(prefix) || normalized.startsWith(`${normalizePath(prefix)}/`));
}

function mimeOf(asset: MediaAssetInput): string {
  if (asset.mime && asset.mime !== '') return asset.mime.toLowerCase();
  const ext = asset.name.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_EXTENSION_MAP[ext] ?? '';
}

/**
 * 分类 + 校验（类型白名单 → 大小上限 → 路径白名单）。
 * 任一层不通过即拒绝（带理由），不静默丢弃。
 */
export function classifyMediaAsset(
  asset: MediaAssetInput,
  options: { pathAllowlist?: readonly string[] } = {},
): MediaVerdict {
  const mime = mimeOf(asset);
  const kind = classByMime(mime);
  if (kind === 'other') {
    return { ok: false, reason: `不支持的文件类型：${asset.name}` };
  }
  const limit = MEDIA_SIZE_LIMITS[kind];
  if (asset.size !== undefined && asset.size > limit) {
    return { ok: false, reason: `文件超限（上限 ${Math.round(limit / 1024 / 1024)}MB）：${asset.name}` };
  }
  // 路径白名单仅在真实路径信息在场时校验（纯文件名 ≠ 本地路径）
  if ((kind === 'video' || kind === 'document') && typeof asset.path === 'string' && asset.path !== '') {
    if (!isPathAllowed(asset.path, options.pathAllowlist ?? DEFAULT_PATH_ALLOWLIST)) {
      return { ok: false, reason: `路径越权（白名单之外）：${asset.name}` };
    }
  }
  return { ok: true, kind };
}

export function classByMime(mime: string): ClassifiedKind {
  if ((IMAGE_MIME as readonly string[]).includes(mime)) return 'image';
  if ((VIDEO_MIME as readonly string[]).includes(mime)) return 'video';
  if ((DOCUMENT_MIME as readonly string[]).includes(mime)) return 'document';
  return 'other';
}

/** 视频/图片渲染路径白名单校验（消息落位后的二次防线）。 */
export function isMediaRenderAllowed(asset: {
  mime?: string;
  size?: number;
  path?: string;
}, options: { pathAllowlist?: readonly string[] } = {}): MediaVerdict {
  const mime = (asset.mime ?? '').toLowerCase();
  const kind = classByMime(mime);
  if (kind === 'other') return { ok: false, reason: `未知媒体类型：${mime || '(空)'}` };
  const limit = MEDIA_SIZE_LIMITS[kind];
  if (asset.size !== undefined && asset.size > limit) {
    return { ok: false, reason: `媒体超限（上限 ${Math.round(limit / 1024 / 1024)}MB）` };
  }
  if ((kind === 'video' || kind === 'document') && asset.path && !isPathAllowed(asset.path, options.pathAllowlist ?? DEFAULT_PATH_ALLOWLIST)) {
    return { ok: false, reason: '媒体路径不在白名单内' };
  }
  return { ok: true, kind };
}

/** 人读大小（字节 → KB/MB 摘要）。 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 媒体 URL 协议白名单：仅 http(s)（远端）与本地路径（~/、/、file:）
 * 放行；javascript:/data: 等一律拒绝（防注入）。
 * 本地路径须位于路径白名单前缀之下（越权即拒）。
 */
export function isSafeMediaUrl(url: string, pathAllowlist: readonly string[] = DEFAULT_PATH_ALLOWLIST): boolean {
  const normalized = url.trim();
  const lower = normalized.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:')) return false;
  if (lower.startsWith('https://') || lower.startsWith('http://')) return true;
  if (lower.startsWith('file://')) return isPathAllowed(normalized.slice('file://'.length), pathAllowlist);
  if (normalized.startsWith('~/') || normalized.startsWith('/')) return isPathAllowed(normalized, pathAllowlist);
  return false;
}
