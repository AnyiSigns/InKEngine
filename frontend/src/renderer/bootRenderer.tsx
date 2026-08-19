/**
 * boot 渲染器：界面描述（JSON 布局树）→ 组件树。
 *
 * 布局数据与引擎 UISpec 数据形态同构：容器递归组织层级，组件经
 * 动态组件注册表解析（白名单外 = 占位拒绝）；数据绑定（bind）挂
 * 状态通道订阅——布局 JSON 变更即重渲（产品形态随数据演化）。
 * 主题 token 应用到 CSS 变量（--forge-*），变更即时生效。
 */

import { useEffect } from 'react';

import { DynamicComponent } from '@/registry/componentRegistry';

import { StateChannelProvider } from './stateChannel';
import type { StateChannel } from './stateChannel';

export interface UIBind {
  channel: string;
  path: string;
}

export interface UINode {
  kind: 'container' | 'component';
  type: string;
  props?: Record<string, unknown>;
  bind?: UIBind;
  children?: UINode[];
}

export interface UISpec {
  name: string;
  root: UINode | null;
  theme?: Record<string, string>;
  version?: number;
}

/** 主题 token → CSS 变量（--forge-*）：应用与还原成对，卸载时清理。 */
function applyTheme(theme: Record<string, string> | undefined): () => void {
  const root = document.documentElement;
  const applied: string[] = [];
  for (const [key, value] of Object.entries(theme ?? {})) {
    const variable = `--forge-${key}`;
    root.style.setProperty(variable, value);
    applied.push(variable);
  }
  return () => {
    for (const variable of applied) root.style.removeProperty(variable);
  };
}

/** boot 渲染器：布局树根入口（未定形 = 占位提示）。 */
export function BootRenderer({
  spec,
  channel = null,
}: {
  spec: UISpec | null;
  /** 状态通道（bind 订阅数据源；缺省 = 绑定组件显示未绑定） */
  channel?: StateChannel<unknown> | null;
}) {
  useEffect(() => applyTheme(spec?.theme), [spec?.theme]);
  if (!spec?.root) {
    return (
      <div className="rounded-md border border-dashed border-foreground/15 px-4 py-6 text-center text-[11px] text-muted-foreground/60">
        界面未定形（等待 AI 长出布局）
      </div>
    );
  }
  return (
    <StateChannelProvider channel={channel}>
      <div className="rounded-md border border-foreground/10 bg-background p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] font-medium text-foreground/50">{spec.name}</span>
          {spec.version ? (
            <span className="text-[9px] text-foreground/25">v{spec.version}</span>
          ) : null}
        </div>
        <UINodeView node={spec.root} path="root" />
      </div>
    </StateChannelProvider>
  );
}

/** 布局节点递归渲染：容器组织层级，组件经注册表解析（bind 随节点透传）。 */
function UINodeView({ node, path }: { node: UINode; path: string }) {
  if (node.kind === 'container') {
    return (
      <div className="flex flex-col gap-2">
        {node.children?.map((child, index) => (
          <UINodeView key={`${path}.${index}`} node={child} path={`${path}.${index}`} />
        ))}
      </div>
    );
  }
  return <DynamicComponent name={node.type} props={node.props} bind={node.bind ?? null} />;
}
