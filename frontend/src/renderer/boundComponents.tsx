/**
 * 绑定组件集：布局 JSON 引用的内建组件（组件白名单基线）。
 *
 * message_list / agent_input 注册为动态组件表内建件：布局树引用即
 * 渲染；绑定组件的数据由渲染器订阅状态通道（bind 协议）后经
 * bindValue 注入——通道变更即重渲，组件不感知通道细节。
 */

import type { AgentStepMessage } from '@/features/agent/agentStore';
import { registerComponent } from '@/registry/componentRegistry';

/** 消息列表绑定组件：消费渲染器注入的 bindValue（bind.path 已订阅）。 */
function MessageListBound(props: Record<string, unknown>) {
  const messages = ((props.bindValue as AgentStepMessage[] | undefined) ?? []).slice(-8);
  if (messages.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/15 px-3 py-4 text-center text-[11px] text-muted-foreground/50">
        消息流为空（等待回合事件）
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {messages.map((m) => (
        <div
          key={m.id || `${m.stepId}-${m.roundId}`}
          className="rounded-md border border-foreground/[0.08] bg-foreground/[0.03] px-2.5 py-1.5 text-[11px]"
        >
          <div className="flex items-center gap-2">
            <span className="rounded bg-foreground/10 px-1 py-px text-[9px] text-foreground/50 font-mono">
              {m.type || m.role || 'text'}
            </span>
            <span className="truncate text-foreground/70">
              {(m.content || '').slice(0, 60) || '（无正文）'}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 输入框占位组件：布局描述形态（面板侧输入由 AgentInput 承担）。 */
function AgentInputBound(_props: Record<string, unknown>) {
  return (
    <div className="rounded-md border border-foreground/15 px-3 py-2 text-[11px] text-muted-foreground/60">
      输入框（布局描述形态）
    </div>
  );
}

registerComponent('message_list', { load: () => MessageListBound });
registerComponent('agent_input', { load: () => AgentInputBound });
