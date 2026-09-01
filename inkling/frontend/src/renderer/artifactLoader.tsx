/**
 * 产物组件动态加载（决策「构建产物清单 + 动态 import + 错误边界灰化」）。
 *
 * 挂载的组件 = 构建产物（哈希 URL 清单）；本模块把清单条目注册为惰性
 * 组件（React.lazy 动态 import + Suspense 占位 + 错误边界灰化 + 审计
 * 上报）。清单数据源 = 宿主后端（componentsManifest），挂载成功后由
 * 装配层调用 refreshArtifactManifest 刷新注册表（新组件次回合可见）。
 *
 * 安全面：只注册清单内条目（名 + 哈希 URL 由宿主产物目录产出），
 * 未声明组件名拒绝注册；加载异常 = 灰化占位 + 审计，不击穿面板。
 */

import { Component, lazy, Suspense } from 'react';
import type { ComponentType, ErrorInfo, ReactNode } from 'react';

import { registerComponent } from './componentRegistry';
import { logger } from '@/shared/logger';
import type { ArtifactManifestEntry, BackendAdapter } from '@/shared/backend/backendAdapter';
import {
  registerMessageRenderer,
  registerRendererKey,
  type MessageRendererForm,
} from './messageRendererRegistry';

interface ArtifactComponentProps {
  [key: string]: unknown;
}

/** 产物组件契约（自写组件须导出 default = 无副作用渲染组件）。 */
interface ArtifactModule {
  default: ComponentType<ArtifactComponentProps>;
}

/** 产物 URL 协议白名单：http(s) 绝对地址或站内相对路径；其余拒绝（fail-closed）。 */
export function isSafeArtifactUrl(url: string): boolean {
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** 哈希形态校验（十六进制串；清单条目带 hash 时须通过，否则整条拒绝）。 */
const ARTIFACT_HASH_RE = /^[a-f0-9]{16,128}$/i;
function isPlausibleHash(hash: string): boolean {
  return ARTIFACT_HASH_RE.test(hash);
}

/** 惰性组件注册（同名覆盖：产物可接管既有组件；未声明名拒绝）。 */
export function registerArtifactComponent(name: string, lazyComp: ComponentType<ArtifactComponentProps>): boolean {
  if (!name || !/^[a-z][a-z0-9_]{1,63}$/.test(name)) return false;
  registerComponent(name, lazyComp);
  return true;
}

/** 哈希 URL 惰性组件（import 失败 = 灰化占位 + 审计，不抛穿）。 */
export function lazyArtifactComponent(url: string, name: string): ComponentType<ArtifactComponentProps> {
  return lazy(async () => {
    if (!isSafeArtifactUrl(url)) {
      logger.error('artifact', `产物组件 URL 协议非法已拒绝: ${name}`, { name, url });
      return artifactFailedPlaceholder(name);
    }
    try {
      const mod = (await import(/* @vite-ignore */ url)) as ArtifactModule;
      if (!mod || typeof mod.default !== 'function') {
        throw new Error(`产物组件缺 default 导出: ${name}`);
      }
      return { default: mod.default };
    } catch (err) {
      logger.error('artifact', `产物组件加载失败: ${name} @ ${url}`, { name, url });
      return artifactFailedPlaceholder(name);
    }
  });
}

/** 产物组件加载失败的灰化占位（不抛穿，允许管理台卸载后重试）。 */
function artifactFailedPlaceholder(name: string): { default: ComponentType<ArtifactComponentProps> } {
  return {
    default: () => (
      <div className="border border-dashed px-3 py-2 text-[11px] ink-border ink-text-faint" data-ui={`artifact_failed_${name}`}>
        {name} 加载失败，已灰化（可在管理台卸载后重试）
      </div>
    ),
  };
}

/** 产物渲染错误边界：单组件崩 → 灰化 + 事件上报，不拖垮 UI。 */
export class ArtifactBoundary extends Component<{ name: string; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error('artifact', `产物组件渲染崩溃: ${this.props.name}`, { error: error.message, info: info.componentStack });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="border border-dashed px-3 py-2 text-[11px] ink-border ink-text-faint" data-ui={`artifact_crashed_${this.props.name}`}>
          {this.props.name} 渲染失败，已灰化（重启后仍失败可回退卸载）
        </div>
      );
    }
    return this.props.children;
  }
}

/** 产物组件挂载点（Suspense + 错误边界 + 灰化）。 */
export function ArtifactComponent({ name, url, props }: { name: string; url: string; props?: Record<string, unknown> }) {
  if (!isSafeArtifactUrl(url)) {
    const Placeholder = artifactFailedPlaceholder(name).default;
    return <Placeholder />;
  }
  const Comp = lazyArtifactComponent(url, name);
  return (
    <ArtifactBoundary name={name}>
      <Suspense
        fallback={
          <div className="border border-dashed px-3 py-2 text-[11px] ink-border ink-text-faint" data-ui={`artifact_loading_${name}`}>
            {name} 加载中…
          </div>
        }
      >
        <Comp {...(props ?? {})} />
      </Suspense>
    </ArtifactBoundary>
  );
}

/** 清单 → 注册表构件（逐条校验：名称合法性 + 哈希 URL 形态 + 协议白名单）。 */
export function registerArtifactManifest(entries: ArtifactManifestEntry[]): number {
  let registered = 0;
  for (const entry of entries) {
    if (!entry.name || !entry.url) continue;
    if (!isSafeArtifactUrl(entry.url)) continue;
    // 清单条目带 hash 时须为十六进制形态（宿主产物哈希），否则整条拒绝
    if (entry.hash && !isPlausibleHash(entry.hash)) continue;
    const lazyComp = lazyArtifactComponent(entry.url, entry.name);
    if (registerArtifactComponent(entry.name, lazyComp)) {
      registered += 1;
    }
    // 清单条目带 renderer_key → 登记为白名单键并绑定自定义消息渲染器
    // （view_forms 决定可用形态；键名非法时白名单拒绝、绑定 fail-closed）。
    if (entry.renderer_key) {
      registerRendererKey(entry.renderer_key);
      const forms = (entry.view_forms ?? ['mini', 'overlay']).filter(
        (f): f is MessageRendererForm => f === 'mini' || f === 'overlay',
      );
      registerMessageRenderer(entry.renderer_key, lazyComp, forms);
    }
  }
  if (registered > 0) {
    logger.info('artifact', `产物清单已刷新：{count=}`, { count: registered });
  }
  return registered;
}

/**
 * 宿主清单刷新（挂载后注册表刷新的数据源入口）：拉取宿主产物清单 →
 * 注册表构件；宿主不可用 = 零注册（既有组件照常）。
 */
export async function refreshArtifactManifest(backend: BackendAdapter | null): Promise<number> {
  if (!backend?.available) return 0;
  try {
    const manifest = await backend.componentsManifest();
    return registerArtifactManifest(manifest.artifacts ?? []);
  } catch {
    return 0;
  }
}
