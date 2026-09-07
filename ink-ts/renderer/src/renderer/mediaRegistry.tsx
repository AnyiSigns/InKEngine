/**
 * 媒体渲染器白名单注册表（图片/视频/文档等消息的渲染分发层）。
 *
 * 每个媒体类型须经 registerMediaRenderer 显式注册（注册即白名单放行）；
 * 未注册的类型 resolveMediaRenderer 返回 null，消息条目渲染「未登记
 * 渲染器」占位拒绝——与组件注册表同一套拦截思想：不执行未声明代码。
 * 内置渲染器由 media_builtins 模块加载即注册。
 */

import type { ComponentType } from 'react';

export interface MediaAssetView {
  url: string;
  mime?: string;
  size?: number;
  alt?: string;
  width?: number;
  height?: number;
  name?: string;
  title?: string;
}

export type MediaRenderer = ComponentType<{ asset: MediaAssetView }>;

const renderers = new Map<string, MediaRenderer>();

/** 注册媒体渲染器（同名覆盖——注册即白名单放行）。 */
export function registerMediaRenderer(kind: string, renderer: MediaRenderer): void {
  if (!kind) throw new Error('媒体类型不能为空');
  renderers.set(kind, renderer);
}

export function isMediaRendererRegistered(kind: string): boolean {
  return renderers.has(kind);
}

/** 解析渲染器：未注册返回 null（调用方渲染拒绝占位）。 */
export function resolveMediaRenderer(kind: string): MediaRenderer | null {
  return renderers.get(kind) ?? null;
}

/** 已注册媒体类型清单（诊断/测试用）。 */
export function registeredMediaKinds(): string[] {
  return [...renderers.keys()];
}
