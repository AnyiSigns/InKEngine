/**
 * 事件订阅 hub（serve 形态事件订阅通道的事件源侧）。
 *
 * topics 订阅形态（T6 web 前端将按此连接）：
 * - events.*           全部引擎事件（EngineTransport 输入面）；
 * - events.<type>      单事件类型（如 events.reply_token）；
 * - state.* / state.<n> serve 侧状态事件（round 驱动完成 / server 就绪等）。
 *
 * 匹配规则：完整相等；`*` 通配全量；`前缀.*` 匹配前缀段。hub 与 IO 解耦：
 * 订阅方是回调（sink），serve 的 ws 层把每个连接适配为 sink；hub 不感知 ws。
 */

import type { EngineEvent, EngineTransport } from '@ink-ts/engine';

export interface HubMessage {
  topic: string;
  data: unknown;
}

export type HubSink = (message: HubMessage) => void;

/** topic 模式匹配：相等 / `*` / `前缀.*`（`events.` 前缀匹配到任意子类型）。 */
export function topicMatches(topic: string, pattern: string): boolean {
  if (pattern === topic || pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return topic.startsWith(prefix);
  }
  return false;
}

/** 订阅会话（去订阅句柄）。 */
export interface HubSubscription {
  close(): void;
}

/** 事件/状态分发 hub（EngineTransport 实现 + 状态事件面）。 */
export class EventHub implements EngineTransport {
  private readonly subscribers = new Map<object, { topics: readonly string[]; sink: HubSink }>();

  /** 注册订阅（topics 模式列表）；返回去订阅句柄（幂等）。 */
  subscribe(topics: readonly string[], sink: HubSink): HubSubscription {
    const key = {};
    this.subscribers.set(key, { topics: [...topics], sink });
    return {
      close: (): void => {
        this.subscribers.delete(key);
      },
    };
  }

  /** 广播一条消息到所有命中订阅（订阅方异常不影响其它订阅/引擎执行）。 */
  publish(topic: string, data: unknown): void {
    for (const entry of [...this.subscribers.values()]) {
      if (!entry.topics.some((pattern) => topicMatches(topic, pattern))) continue;
      try {
        entry.sink({ topic, data });
      } catch {
        // 单订阅投递失败（连接已坏）忽略：hub 不因单个消费者故障中断
      }
    }
  }

  /** EngineTransport：引擎事件 → events.<type> 主题（协议结构事件 dict）。 */
  async send(event: EngineEvent): Promise<void> {
    this.publish(`events.${event.type}`, event.to_dict());
  }
}
