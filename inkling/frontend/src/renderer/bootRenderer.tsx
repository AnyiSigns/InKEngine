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
      <div className="border border-dashed px-4 py-3 text-[11px] ink-border ink-text-muted">
        界面描述损坏或缺失，已回落基线布局
      </div>
      <div className="ink-panel flex-1 p-2">
        <DynamicComponent name="message_list" />
      </div>
      <DynamicComponent name="agent_input" />
    </div>
  );
}

/** 容器间隙（静态类映射：Tailwind 静态扫描无法识别动态拼接类名）。 */
const GAP_CLASSES = ['gap-0', 'gap-1', 'gap-2', 'gap-3'] as const;

/**
 * 布局节点递归渲染：容器组织层级，组件经注册表解析（bind 随节点透传）。
 *
 * 高度传播纪律（线性三栏布局铺满窗口的关键）：
 * - 容器一律 min-h-0（允许收缩，内部滚动区才能生效）；
 * - grow（props.grow 或 views 直接子级）→ flex-1（沿主轴扩展铺满）；
 * - props.gap 控制子级间隙（0 = 无缝 hairline 分隔，Linear 风格）；
 * - props.scroll 的列容器 → overflow-y-auto（视图内容独立滚动）。
 */
function UINodeView({
  node,
  path,
  activeView,
  depth,
  chromeProps,
  grow = false,
}: {
  node: UINode;
  path: string;
  activeView?: ViewId;
  depth: number;
  chromeProps: Record<string, unknown>;
  grow?: boolean;
}) {
  if (depth > MAX_LAYOUT_DEPTH) {
    return (
      <div className="border border-dashed px-3 py-2 text-[11px] ink-border ink-text-faint">
        布局层级过深（{path}），跳过渲染
      </div>
    );
  }

  if (node.kind === 'container') {
    // overlay 容器：不占布局盒位（display:contents 等价语义，用 Fragment
    // 直渲）。弹层组件自带 position:fixed 蒙层，若无盒位则不会在布局树中
    // 留下空隙——此前 overlay 被当作普通 flex 子项（0 高）渲染，根容器
    // gap-2 的间隙在 views 容器下方露出 8px 底色带（"上灰下白"）。
    if (node.type === 'overlay') {
      const layerChildren = node.children ?? [];
      return (
        <>
          {layerChildren.map((child, index) => (
            <UINodeView
              key={`${path}.${index}`}
              node={child}
              path={`${path}.${index}`}
              activeView={activeView}
              depth={depth + 1}
              chromeProps={chromeProps}
              grow={grow}
            />
          ))}
        </>
      );
    }
    // views 容器：按 activeView 过滤（未指定 = 全部渲染，直渲语义）
    const children = node.children ?? [];
    if (node.type === 'views' && activeView) {
      const filtered = children.filter((child) => (child.props?.view as string | undefined) === activeView);
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          {filtered.map((child, index) => (
            <UINodeView
              key={`${path}.${index}`}
              node={child}
              path={`${path}.${index}`}
              activeView={activeView}
              depth={depth + 1}
              chromeProps={chromeProps}
              grow
            />
          ))}
        </div>
      );
    }
    const isRow = node.type === 'row';
    const gap = typeof node.props?.gap === 'number' ? Math.min(Math.max(node.props.gap, 0), 3) : 2;
    const growClass = grow || node.props?.grow === true ? 'flex-1 min-h-0 min-w-0' : 'min-h-0 min-w-0';
    const scrollClass = !isRow && node.props?.scroll === true ? 'overflow-y-auto' : '';
    return (
      <div className={`flex ${isRow ? 'flex-row' : 'flex-col'} ${GAP_CLASSES[gap]} ${growClass} ${scrollClass}`}>
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
  /** 输入提交（宿主接线：引擎回合入口） */
  onSend?: (text: string) => void;
  /** 回合中止（宿主接线：停止按钮 → 中止当前回合） */
  onAbort?: () => void;
  /** 附件提交（宿主接线：媒体资产落位消息流） */
  onAttachments?: (assets: unknown[]) => void;
  /** 编辑重发（宿主接线：替换原消息并重发回合） */
  onResendMessage?: (messageId: string, newText: string) => void;
  /** 由此分支（宿主接线：以消息为起点开新分支） */
  onBranchFromMessage?: (messageId: string, branchLabel: string) => void;
  /** 会话激活（宿主接线：装入会话消息） */
  onActivateSession?: (sessionId: string) => void;
  /** 界面树应用（宿主接线：替换活动界面描述） */
  onApplyUiSpec?: (spec: UISpec) => void;
  /** 备份/恢复向导（宿主接线：安全信任节/管理台入口） */
  onOpenBackupWizard?: (mode: 'export' | 'restore') => void;
  /** 设置应用（宿主接线：能力档持久化） */
  onApplySettings?: (settings: Record<string, unknown>) => void;
  /** 宿主能力档初值（启动时从后端装载） */
  initialCapability?: Record<string, unknown> | undefined;
  /** 活动界面描述（界面树编辑器的读入面） */
  uiSpec?: UISpec | null;
  /** 会话存储（会话侧栏的数据面；宿主接线注入） */
  sessionStore?: unknown;
  /** 当前活动会话（会话侧栏高亮） */
  activeSessionId?: string;
  /** 架构视图基线快照（视觉 diff 的面） */
  architectureBaseline?: unknown;
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
  onSend,
  onAbort,
  onAttachments,
  onResendMessage,
  onBranchFromMessage,
  onActivateSession,
  onApplyUiSpec,
  onOpenBackupWizard,
  onApplySettings,
  initialCapability,
  uiSpec,
  sessionStore,
  activeSessionId,
  architectureBaseline,
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
  if (onSend) chromeProps.onSend = onSend;
  if (onAbort) chromeProps.onAbort = onAbort;
  if (onAttachments) chromeProps.onAttachments = onAttachments;
  if (onResendMessage) chromeProps.onResendMessage = onResendMessage;
  if (onBranchFromMessage) chromeProps.onBranchFromMessage = onBranchFromMessage;
  if (onActivateSession) chromeProps.onActivateSession = onActivateSession;
  if (onApplyUiSpec) chromeProps.onApplyUiSpec = onApplyUiSpec;
  if (onOpenBackupWizard) chromeProps.onOpenBackupWizard = onOpenBackupWizard;
  if (onApplySettings) chromeProps.onApplySettings = onApplySettings;
  if (initialCapability !== undefined) chromeProps.initialCapability = initialCapability;
  if (uiSpec !== undefined) chromeProps.uiSpec = uiSpec;
  if (sessionStore !== undefined) chromeProps.sessionStore = sessionStore;
  if (activeSessionId !== undefined) chromeProps.activeSessionId = activeSessionId;
  if (architectureBaseline !== undefined) chromeProps.architectureBaseline = architectureBaseline;

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
          <UINodeView node={clean.root} path="root" activeView={activeView} depth={0} chromeProps={chromeProps} grow />
        ) : (
          <BaselineLayout />
        )}
      </div>
    </BindSourceProvider>
  );
}
