/**
 * milestone_reached 事件自定义渲染器（自举实证产物）。
 *
 * 注册机制：milestone_reached 不在 EVENT_TYPE_NAMES 基线白名单内，
 * 须先 registerRendererKey 登记白名单，再 registerMessageRenderer 绑定。
 */
import type { MessageRenderer, MessageRendererProps } from './messageRendererRegistry';
import { registerMessageRenderer, registerRendererKey } from './messageRendererRegistry';

const MilestoneEntry: MessageRenderer = (props: MessageRendererProps) => {
  const payload = (props.event ?? {}) as { title?: string; detail?: string };
  return (
    <div className="milestone-entry">
      <strong>{payload.title ?? '事件达成'}</strong>
      {payload.detail ? <p>{payload.detail}</p> : null}
    </div>
  );
};

export function registerMilestoneEntry(): boolean {
  registerRendererKey('milestone_reached');
  return registerMessageRenderer('milestone_reached', MilestoneEntry);
}
