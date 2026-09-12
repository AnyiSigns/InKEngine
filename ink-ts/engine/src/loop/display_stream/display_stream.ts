/**
 * 事件展示流聚合器：从引擎事件流派生展示态消息流（display_messages）。
 *
 * 定位（事件展示层）：引擎节点（如 llm_decider）只发射事件（thinking_start/
 * thinking_end/tool_start/tool_end/reply_token...），不累积展示态。本聚合器
 * 作为 EngineTransport 挂在回合 transport 上，从事件流重建展示消息流：
 *  - thinking 卡：thinking_start 开卡/分片追加 → thinking_end 定型 completed；
 *  - tool 卡：tool_start 建卡（工具名/输入/running）→ tool_end 定型（done/error
 *    + 输出）；
 *  - 正文：reply_token 帧按 round_id 拼接为 assistant 正文条目。
 *
 * 展示态与上下文 messages 完全无关（不喂模型），是给前端/宿主读回展示的
 * 独立数据面。step_id 用展示流水号（display:<n> 全局唯一，跨轮不冲突）。
 *
 * 用户输入展示条目不归本聚合器——由 runtime _append_round_user_message 在
 * 回合入口注入（与 messages 会话级累积同步），收尾合并到展示流前段。
 */

import type { EngineEvent, EngineTransport } from '../../dock/ports/events.js';

/** 展示消息条目（JSON 持久化形态：与前端归约 InkMessage 同构简化）。 */
export type DisplayMessage = Record<string, unknown>;

/** 事件展示聚合器（EngineTransport 实现；send 永不失败）。 */
export class DisplayStreamCollector implements EngineTransport {
  private messages: DisplayMessage[] = [];
  private seq = 0;
  /** 按 step_id 定位的开放条目（thinking 卡/tool 卡），做分片就地累积。 */
  private byStep = new Map<string, DisplayMessage>();

  private nextStep(): string {
    this.seq += 1;
    return `display:${this.seq}`;
  }

  async send(event: EngineEvent): Promise<void> {
    switch (event.type) {
      case 'thinking_start': {
        const stepId = event.step_id ?? 'think';
        const payload = event.payload;
        const content = typeof payload['content'] === 'string' ? payload['content'] : '';
        const existing = this.byStep.get(stepId);
        if (existing !== undefined) {
          existing['content'] = String(existing['content'] ?? '') + content;
          existing['status'] = 'running';
        } else {
          const entry: DisplayMessage = {
            kind: 'thinking',
            content,
            status: 'running',
            step_id: this.nextStep(),
          };
          this.byStep.set(stepId, entry);
          this.messages.push(entry);
        }
        break;
      }
      case 'thinking_end': {
        const stepId = event.step_id ?? 'think';
        const existing = this.byStep.get(stepId);
        if (existing !== undefined) existing['status'] = 'completed';
        break;
      }
      case 'tool_start': {
        const stepId = event.step_id ?? 'tool';
        const payload = event.payload;
        const toolName = typeof payload['tool'] === 'string' ? payload['tool'] : '';
        const args = typeof payload['args'] === 'string' ? payload['args'] : '';
        const entry: DisplayMessage = {
          kind: 'tool',
          tool: toolName,
          title: toolName,
          args,
          toolStatus: 'running',
          step_id: this.nextStep(),
        };
        this.byStep.set(stepId, entry);
        this.messages.push(entry);
        break;
      }
      case 'tool_end': {
        const stepId = event.step_id ?? 'tool';
        const payload = event.payload;
        const existing = this.byStep.get(stepId);
        const success = payload['success'] === true;
        const summary = typeof payload['summary'] === 'string'
          ? payload['summary']
          : typeof payload['error'] === 'string'
            ? payload['error']
            : '';
        const status = success ? 'done' : 'error';
        if (existing !== undefined) {
          existing['toolStatus'] = status;
          if (summary !== '') existing['summary'] = summary;
        } else {
          this.messages.push({
            kind: 'tool',
            tool: String(payload['tool'] ?? ''),
            title: String(payload['tool'] ?? ''),
            args: '',
            toolStatus: status,
            summary,
            step_id: this.nextStep(),
          });
        }
        break;
      }
      case 'reply_token': {
        const payload = event.payload;
        const token = typeof payload['token'] === 'string' ? payload['token'] : '';
        if (token === '') break;
        // 正文按 round 聚合为一条 assistant 正文条目（追加，不跨 round 混）
        const roundId = event.round_id ?? 'mention';
        let body = this.byStep.get(`reply:${roundId}`);
        if (body === undefined) {
          body = { kind: 'text', role: 'assistant', content: '', step_id: this.nextStep() };
          body['round'] = roundId;
          this.byStep.set(`reply:${roundId}`, body);
          this.messages.push(body);
        }
        body['content'] = String(body['content'] ?? '') + token;
        break;
      }
      default:
        break;
    }
  }

  /** 当前聚合的展示消息流（顺序 = 事件到达序；判断是协议序）。 */
  getMessages(): readonly DisplayMessage[] {
    return this.messages;
  }

  /** 已用展示流水号（供会话级累积续号）。 */
  getSeq(): number {
    return this.seq;
  }

  /** 清空（新回合复用）。 */
  reset(): void {
    this.messages = [];
    this.seq = 0;
    this.byStep = new Map();
  }
}
