/**
 * iframe 嵌入桥：任意 Web 形态（含 AI 自生成游戏/独立应用）经 iframe
 * 嵌入产品面板。
 *
 * 隔离语义：sandbox=allow-scripts（不放行 allow-same-origin——子文档
 * 与宿主 DOM/存储隔离，重型或不可信形态一律走此桥）；postMessage
 * 双向通信 + 来源校验。沙箱子文档来源恒为 "null"，origin 白名单无
 * 法判定归属，入站消息改以「来源窗口身份」校验：消息必须来自受控
 * iframe 的 contentWindow（页面内其它窗口一律拒绝）；显式声明了
 * allowOrigins 时额外要求 origin 命中（非沙箱/同源场景）。出站经
 * onReady 暴露 send 回调（宿主 → 子文档），双向成立。
 *
 * 注册为动态组件表内建件：布局 JSON 引用 type=iframe 即嵌入。
 */

import { useEffect, useMemo, useRef } from 'react';

import { registerComponent } from '@/registry/componentRegistry';

interface IframeBridgeProps {
  src: string;
  title?: string;
  height?: number | string;
  /** 消息来源白名单（绝对来源串；缺省 = 仅来源窗口身份校验） */
  allowOrigins?: string[];
  /** 收到的子文档消息（来源已校验后才回调） */
  onMessage?: (message: unknown) => void;
  /** 挂载就绪：暴露出站发送通道（宿主 → 子文档） */
  onReady?: (send: (message: unknown) => void) => void;
}

export function IframeBridge({
  src,
  title,
  height = 480,
  allowOrigins,
  onMessage,
  onReady,
}: IframeBridgeProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const allowed = useMemo(() => new Set(allowOrigins ?? []), [allowOrigins]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      // 来源校验：消息必须来自受控 iframe 的窗口（沙箱子文档 origin
      // 恒为 "null"，窗口身份比对是唯一可靠判定）
      if (event.source !== frameRef.current?.contentWindow) return;
      // 显式来源白名单场景额外校验 origin（非沙箱内容）
      if (allowed.size > 0 && !allowed.has(event.origin)) return;
      onMessageRef.current?.(event.data);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [allowed]);

  useEffect(() => {
    // 出站通道：宿主 → 子文档（双向通信的发送端；沙箱子文档无来源，
    // 目标源用 *——消息隔离由 sandbox 与入站窗口身份校验兜底）
    const frame = frameRef.current;
    if (!frame) return;
    const send = (message: unknown) => frame.contentWindow?.postMessage(message, '*');
    onReadyRef.current?.(send);
  }, [src]);

  return (
    <div className="overflow-hidden rounded-md border border-foreground/10 bg-background">
      <iframe
        ref={frameRef}
        src={src}
        title={title || '嵌入形态'}
        height={height}
        sandbox="allow-scripts"
        className="w-full"
      />
    </div>
  );
}

/** 注册表入口：布局 props 泛化为 Record，缺失字段回落默认（src 必填由调用方保证）。 */
function IframeBridgeEntry(props: Record<string, unknown>) {
  const { src, title, height, allowOrigins, onMessage, onReady } = props;
  return (
    <IframeBridge
      src={String(src ?? '')}
      title={typeof title === 'string' ? title : undefined}
      height={(height as number | string | undefined) ?? 480}
      allowOrigins={
        Array.isArray(allowOrigins)
          ? (allowOrigins as string[])
          : undefined
      }
      onMessage={typeof onMessage === 'function' ? (onMessage as (m: unknown) => void) : undefined}
      onReady={typeof onReady === 'function' ? (onReady as (s: (m: unknown) => void) => void) : undefined}
    />
  );
}

registerComponent('iframe', { load: () => IframeBridgeEntry });
