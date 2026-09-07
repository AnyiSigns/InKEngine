import { describe, expect, it } from 'vitest';

import { TuiController } from '../../src/tui/controller.js';
import { TXT } from '../../src/tui/text.js';
import type { ApprovalCard, EventLine, SessionSummary, TuiActions, TuiEvents, TuiIntent } from '../../src/tui/types.js';

interface FakeCall {
  method: string;
  params: unknown;
}

class FakeActions implements TuiActions {
  calls: FakeCall[] = [];
  sessions: SessionSummary[] = [];
  approvals: ApprovalCard[] = [];
  messageRows: unknown[] = [];
  todo = { pending: [{ title: '第一步' }, { title: '第二步' }] };
  sessionSeq = 0;

  private log(method: string, params: unknown): void {
    this.calls.push({ method, params });
  }

  async listSessions(): Promise<SessionSummary[]> {
    this.log('records.sessions', undefined);
    return [...this.sessions].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  }

  async createSession(): Promise<SessionSummary> {
    this.log('sessions.create', {});
    this.sessionSeq += 1;
    const session: SessionSummary = { thread_id: `t${this.sessionSeq}`, title: '新会话' };
    this.sessions = [session, ...this.sessions];
    return session;
  }

  async listMessages(threadId: string): Promise<unknown[]> {
    this.log('sessions.messages', { thread_id: threadId });
    return this.messageRows;
  }

  async send(threadId: string, input: string): Promise<unknown> {
    this.log('rounds.send', { thread_id: threadId, input });
    return { thread_id: threadId, ok: true };
  }

  async listTodos(threadId: string): Promise<unknown> {
    this.log('rounds.todos', { thread_id: threadId });
    return this.todo;
  }

  async listApprovals(): Promise<ApprovalCard[]> {
    this.log('approval.list', {});
    return this.approvals;
  }

  async resolveApproval(threadId: string, decision: unknown): Promise<unknown> {
    this.log('approval.resolve', { thread_id: threadId, decision });
    return { resolved: true };
  }
}

class FakeEvents implements TuiEvents {
  listeners: Array<(line: EventLine) => void> = [];
  on(cb: (line: EventLine) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }
  emit(line: EventLine): void {
    for (const listener of this.listeners) listener(line);
  }
}

function makeController(): { actions: FakeActions; events: FakeEvents; frames: number; exits: { count: number }; controller: TuiController } {
  const actions = new FakeActions();
  const events = new FakeEvents();
  let frames = 0;
  const exits = { count: 0 };
  const controller = new TuiController({
    actions,
    events,
    onFrame: () => {
      frames += 1;
    },
    onExit: () => {
      exits.count += 1;
    },
  });
  return { actions, events, frames, exits, controller };
}

const intent = {
  char: (c: string): TuiIntent => ({ kind: 'char', char: c }),
  key: (name: 'enter' | 'backspace' | 'escape' | 'ctrl-c'): TuiIntent => ({ kind: 'key', name }),
};

const card: ApprovalCard = {
  thread_id: 't1',
  key: 'os.run',
  node: 'review',
  graph_path: ['review'],
  payload: { tool: 'shell_exec', argv: ['git', 'status'] },
};

describe('tui controller', () => {
  it('start 打开最近会话并载入消息/待办', async () => {
    const { actions, controller } = makeController();
    actions.sessions = [
      { thread_id: 't9', title: '旧', created_at: 1 },
      { thread_id: 't2', title: '新', created_at: 2 },
    ];
    actions.messageRows = [{ id: 'm1', kind: 'message', role: 'user', text: '你好' }];
    await controller.start();
    expect(controller.model.activeThread).toBe('t2');
    expect(controller.model.messages).toEqual(['⟩ 你好']);
    expect(controller.model.todoLines).toEqual(['1. 第一步', '2. 第二步']);
    expect(actions.calls.some((c) => c.method === 'sessions.messages')).toBe(true);
    expect(actions.calls.some((c) => c.method === 'rounds.todos')).toBe(true);
  });

  it('数字切视图且 approvals 载入队列', async () => {
    const { actions, controller } = makeController();
    actions.sessions = [{ thread_id: 't1', title: null }];
    actions.approvals = [card];
    await controller.start();
    await controller.onIntent(intent.char('4'));
    expect(controller.model.mode).toBe('approvals');
    expect(controller.model.approvals).toHaveLength(1);
    await controller.switchMode('chat');
    expect(controller.model.mode).toBe('chat');
  });

  it('聊天输入回车发送并触发收尾刷新', async () => {
    const { actions, controller } = makeController();
    actions.sessions = [{ thread_id: 't1', title: null }];
    await controller.start();
    for (const char of '你好世界') await controller.onIntent(intent.char(char));
    expect(controller.model.input).toBe('你好世界');
    const sentBefore = actions.calls.filter((c) => c.method === 'rounds.send').length;
    await controller.onIntent(intent.key('enter'));
    expect(actions.calls.filter((c) => c.method === 'rounds.send')).toHaveLength(sentBefore + 1);
    expect(actions.calls.filter((c) => c.method === 'rounds.send').at(-1)?.params).toEqual({
      thread_id: 't1',
      input: '你好世界',
    });
    expect(controller.model.running).toBe(false);
    expect(controller.model.status).toBe(TXT.roundDone);
    expect(actions.calls.some((c) => c.method === 'approval.list')).toBe(true);
  });

  it('无会话时发送自动新建会话', async () => {
    const { actions, controller } = makeController();
    actions.sessions = [];
    await controller.start();
    expect(controller.model.activeThread).toBeNull();
    await controller.submitChat('直接发');
    expect(actions.calls.some((c) => c.method === 'sessions.create')).toBe(true);
    expect(controller.model.activeThread).toBe('t1');
    expect(actions.calls.some((c) => c.method === 'rounds.send')).toBe(true);
  });

  it('审批裁决集：accept/reject+reason/edit+JSON/terminate', async () => {
    const { actions, controller } = makeController();
    actions.sessions = [{ thread_id: 't1', title: null }];
    actions.approvals = [card];
    await controller.start();
    await controller.switchMode('approvals');
    expect(controller.model.approvals[0]?.key).toBe('os.run');

    await controller.onIntent(intent.char('a'));
    expect(actions.calls.filter((c) => c.method === 'approval.resolve').at(-1)?.params).toEqual({
      thread_id: 't1',
      decision: { decision: 'accept' },
    });

    await controller.onIntent(intent.char('r'));
    expect(controller.model.editor?.kind).toBe('reason');
    for (const char of '权限不足') await controller.onIntent(intent.char(char));
    await controller.onIntent(intent.key('enter'));
    expect(actions.calls.filter((c) => c.method === 'approval.resolve').at(-1)?.params).toEqual({
      thread_id: 't1',
      decision: { decision: 'reject', reason: '权限不足' },
    });

    await controller.onIntent(intent.char('e'));
    expect(controller.model.editor?.kind).toBe('edit');
    for (const char of '{"argv":["git","log"]}') await controller.onIntent(intent.char(char));
    await controller.onIntent(intent.key('enter'));
    expect(actions.calls.filter((c) => c.method === 'approval.resolve').at(-1)?.params).toEqual({
      thread_id: 't1',
      decision: { decision: 'edit', edited_content: { argv: ['git', 'log'] } },
    });

    await controller.onIntent(intent.char('t'));
    expect(actions.calls.filter((c) => c.method === 'approval.resolve').at(-1)?.params).toEqual({
      thread_id: 't1',
      decision: { decision: 'terminate' },
    });
  });

  it('审批 edit 非法 JSON 留在编辑器并报状态', async () => {
    const { actions, controller } = makeController();
    actions.sessions = [{ thread_id: 't1', title: null }];
    actions.approvals = [card];
    await controller.start();
    await controller.switchMode('approvals');
    await controller.onIntent(intent.char('e'));
    for (const char of 'not-json') await controller.onIntent(intent.char(char));
    await controller.onIntent(intent.key('enter'));
    expect(controller.model.editor).toBeNull();
    expect(controller.model.status).toContain(TXT.badJson);
    const resolveCount = actions.calls.filter((c) => c.method === 'approval.resolve').length;
    expect(resolveCount).toBe(0);
  });

  it('事件订阅把事件行推进尾部（环形裁剪）', async () => {
    const { events, controller } = makeController();
    await controller.start();
    events.emit({ topic: 'events.round_started', text: 'events.round_started 组装' });
    expect(controller.model.events.at(-1)?.topic).toBe('events.round_started');
  });

  it('ctrl-c 两次确认退出（y 才退出）', async () => {
    const { controller, exits } = makeController();
    await controller.start();
    await controller.onIntent(intent.key('ctrl-c'));
    expect(controller.model.quitting).toBe(true);
    await controller.onIntent(intent.char('n'));
    expect(controller.model.quitting).toBe(false);
    await controller.onIntent(intent.key('ctrl-c'));
    await controller.onIntent(intent.char('y'));
    expect(exits.count).toBe(1);
    expect(controller.model.done).toBe(true);
  });
});
