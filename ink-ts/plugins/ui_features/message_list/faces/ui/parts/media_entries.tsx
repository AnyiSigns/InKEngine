/**
 * 媒体条目（图片/视频/文档消息的卡片渲染）+ 内置媒体渲染器注册。
 *
 * 图片：img 直渲（url/尺寸/alt）；视频：先过媒体白名单（类型/大小/
 * 路径/URL 协议）再经媒体渲染器白名单注册的分发面渲染播放器，拒绝
 * 输出「已拒绝」占位并给理由（不渲染 <video>）；文档：文件芯片卡。
 */

import type { ComponentType } from 'react';

import { FileText } from 'lucide-react';

import { registerMediaRenderer } from '@/renderer/mediaRegistry';
import type { MediaAssetView } from '@/renderer/mediaRegistry';
import { isMediaRenderAllowed, formatByteSize, isSafeMediaUrl } from '@/shared/media/mediaPolicy';
import type { InkDocumentMessage, InkImageMessage, InkVideoMessage } from '@/shared/session/types';

/** 媒体消息 → 渲染器资产面（条目层按 kind 收敛脏字段）。 */
export function assetOf(message: InkImageMessage | InkVideoMessage | InkDocumentMessage): MediaAssetView {
  if (message.kind === 'image') {
    return { url: message.url, mime: message.mime, alt: message.alt, width: message.width, height: message.height };
  }
  if (message.kind === 'video') {
    return { url: message.url, mime: message.mime, size: message.size, title: message.title };
  }
  return { url: message.url ?? '', name: message.name, size: message.size };
}

/** 媒体拒绝占位（未登记渲染器/越权/超限的统一拒绝面，不静默丢弃）。 */
export function MediaRejected({ kind, reason }: { kind: string; reason: string }) {
  return (
    <div className="ink-status-card px-3 py-2 text-[11px] ink-text-faint" data-ui="media_rejected" data-kind={kind}>
      已拒绝：{reason}
    </div>
  );
}

const ImageMediaRenderer: ComponentType<{ asset: MediaAssetView }> = function ImageMediaRenderer({ asset }) {
  if (asset.url && !isSafeMediaUrl(asset.url)) {
    return (
      <div className="ink-status-card px-3 py-2 text-[11px] ink-text-faint" data-ui="media_rejected">
        已拒绝：图片地址协议不在白名单内
      </div>
    );
  }
  return (
    <img
      src={asset.url}
      alt={asset.alt ?? ''}
      width={asset.width}
      height={asset.height}
      loading="lazy"
      className="max-w-full rounded-[var(--ink-radius-md)] border border-[var(--ink-border)]"
      data-ui="media_image"
    />
  );
};

const VideoMediaRenderer: ComponentType<{ asset: MediaAssetView }> = function VideoMediaRenderer({ asset }) {
  const verdict = isMediaRenderAllowed({ mime: asset.mime, size: asset.size }, { pathAllowlist: undefined });
  if (!verdict.ok) {
    return (
      <div className="ink-status-card px-3 py-2 text-[11px] ink-text-faint" data-ui="media_rejected">
        已拒绝：{verdict.reason}
      </div>
    );
  }
  if (!asset.url || !isSafeMediaUrl(asset.url)) {
    return (
      <div className="ink-status-card px-3 py-2 text-[11px] ink-text-faint" data-ui="media_rejected">
        已拒绝：视频地址协议不在白名单内
      </div>
    );
  }
  return (
    <video
      controls
      preload="metadata"
      className="max-h-72 max-w-full rounded-[var(--ink-radius-md)] border border-[var(--ink-border)]"
      data-ui="media_video"
    >
      <source src={asset.url} type={asset.mime} />
      当前环境不支持视频播放
    </video>
  );
};

const DocumentMediaRenderer: ComponentType<{ asset: MediaAssetView }> = function DocumentMediaRenderer({ asset }) {
  return (
    <div className="flex items-center gap-2.5" data-ui="media_document">
      <span className="ink-icon-chip h-5 w-5">
        <FileText size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px]">{asset.name ?? asset.url}</span>
      {asset.size !== undefined && <span className="shrink-0 font-mono text-[10px] ink-text-faint">{formatByteSize(asset.size)}</span>}
    </div>
  );
};

/** 装配内置媒体渲染器（模块加载即注册 = 白名单放行）。 */
export function registerBuiltinMediaRenderers(): void {
  registerMediaRenderer('image', ImageMediaRenderer);
  registerMediaRenderer('video', VideoMediaRenderer);
  registerMediaRenderer('document', DocumentMediaRenderer);
}

registerBuiltinMediaRenderers();
