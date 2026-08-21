/**
 * UIRenderer（机制件二核心）：ui_spec.json 布局树直渲。
 *
 * 渲染管线：
 * 1. 结构校验（validation）——损坏 ui_spec 回落基线布局，不崩溃；
 * 2. 主题 token 白名单应用（themeTokens）——未声明 token 拒绝落地；
 * 3. 布局树递归直渲——容器组织层级，组件经注册表白名单解析，
 *    bind 经绑定通道白名单校验后注入数据（state/events/inspect）。
 *
 * 视图切换（activeView）：root 下 "views" 容器内按 props.view 过滤，
 * 默认渲染全部（直渲语义不裁剪）。审批卡 overlay 容器常驻任意视图可弹。
 */

import { useEffect } from 'react';

import type { ChannelHub } from '@/shared/session/channelHub';
import { BindSourceProvider } from './bindSource';
import { DynamicComponent } from './componentRegistry';
import { applyThemeTokens } from './themeTokens';
import type { UINode, UISpec, ViewId } from './uiSpecTypes';
import { logSpecDamage, normalizeSpec, validateUiSpec } from './validation';

const MAX_LAYOUT_DEPTH = 64;

/** 基线布局：主界面 = 消息流 + 输入框（损坏 spec 的回落形态，不白屏）。 */
function BaselineLayout() {
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="rounded-md border border-dashed px-4 py-3 text-[11px] ink-border ink-text-muted">
        界面描述损坏或缺失，已回落基线布局
      </div>
      <div className="ink-panel flex-1 rounded-md p-2">
        <DynamicComponent name="message_list" />
      </div>
      <DynamicComponent name="agent_input" />
    </div>
  );
}

/** 布局节点递归渲染：容器组织层级，组件经注册表解析（bind 随节点透传）。 */
function UINodeView({
  node,
  path,
  activeView,
  depth,
  chromeProps,
}: {
  node: UINode;
  path: string;
  activeView?: ViewId;
  depth: number;
  chromeProps: Record<string, unknown>;
}) {
  if (depth > MAX_LAYOUT_DEPTH) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2 text-[11px] ink-border ink-text-faint">
        布局层级过深（{path}），跳过渲染
      </div>
    );
  }

  if (node.kind === 'container') {
    // views 容器：按 activeView 过滤（未指定 = 全部渲染，直渲语义）
    const children = node.children ?? [];
    if (node.type === 'views' && activeView) {
      const filtered = children.filter((child) => (child.props?.view as string | undefined) === activeView);
      return (
        <div className="flex h-full flex-col">
          {filtered.map((child, index) => (
            <UINodeView
              key={`${path}.${index}`}
              node={child}
              path={`${path}.${index}`}
              activeView={activeView}
              depth={depth + 1}
              chromeProps={chromeProps}
            />
          ))}
        </div>
      );
    }
    return (
      <div className={`flex ${node.type === 'row' ? 'flex-row' : 'flex-col'} gap-2`}>
        {children.map((child, index) => (
          <UINodeView
            key={`${path}.${index}`}
            node={child}
            path={`${path}.${index}`}
            activeView={activeView}
            depth={depth + 1}
            chromeProps={chromeProps}
          />
        ))}
      </div>
    );
  }

  return <DynamicComponent name={node.type} props={node.props} bind={node.bind ?? null} chromeProps={chromeProps} />;
}

export interface RendererChrome {
  /** 视图切换（顶栏导航） */
  onNavigate?: (view: ViewId) => void;
  /** 审批卡决议（accept/reject/edit/terminate） */
  onResolveReview?: (resolution: 'accept' | 'reject' | 'edit' | 'terminate', editedContent?: string) => void;
}

/**
 * UIRenderer 入口：spec 直渲 + 主题应用 + 通道注入。
 * spec 损坏 → 回落基线；theme 未声明 → 出厂默认 token。
 * chrome（导航/审批回调）经壳注入组件，机制回调不进布局数据。
 */
export function UIRenderer({
  spec,
  hub,
  activeView,
  onNavigate,
  onResolveReview,
}: {
  spec: UISpec | null;
  hub: ChannelHub | null;
  activeView?: ViewId;
} & RendererChrome) {
  const validation = validateUiSpec(spec);
  const clean = validation.ok && spec ? normalizeSpec(spec) : null;

  useEffect(() => {
    if (!clean) return undefined;
    return applyThemeTokens(clean.theme);
  }, [clean]);

  const chromeProps: Record<string, unknown> = {};
  if (onNavigate) chromeProps.onNavigate = onNavigate;
  if (onResolveReview) chromeProps.onResolveReview = onResolveReview;

  if (!clean) {
    logSpecDamage(spec?.name ?? '(null)', validation.reason ?? '未知损坏');
    return (
      <BindSourceProvider value={hub ? { hub } : null}>
        <BaselineLayout />
      </BindSourceProvider>
    );
  }

  return (
    <BindSourceProvider value={hub ? { hub } : null}>
      <div className="flex h-full flex-col">
        {clean.root ? (
          <UINodeView node={clean.root} path="root" activeView={activeView} depth={0} chromeProps={chromeProps} />
        ) : (
          <BaselineLayout />
        )}
      </div>
    </BindSourceProvider>
  );
}
