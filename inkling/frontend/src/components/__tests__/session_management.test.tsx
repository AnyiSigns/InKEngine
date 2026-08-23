/**
 * 会话管理测试：存储 CRUD/持久化/最近活跃排序、标题生成降级、
 * 侧栏交互（新建/切换/删除确认/重命名）、hover 操作（编辑重发/由此分支）。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionList } from '@/components/session_list';
import { MessageList } from '@/components/message_list';
import { MessageActionFloater } from '@/components/floaters/message_action_floater';
import { MemorySessionStore, createMemoryStorage, createPersistentSessionStore, generateSessionTitle } from '@/shared/session/sessionStore';
import type { SessionRecord } from '@/shared/session/sessionStore';
import type { InkMessage } from '@/shared/session/types';

function seedRecords(): SessionRecord[] {
  const base = Date.now() - 86400000;
  const mk = (id: string, title: string, offsetMin: number): SessionRecord => ({
    id,
    title,
    titleSource: 'generated',
    createdAt: base + offsetMin * 60000,
    lastActiveAt: base + offsetMin * 60000,
    messages: [],
  });
  return [mk('s-old', '昨天会话', 30), mk('s-recent', '最近会话', 120)];
}

function seededStore(): MemorySessionStore {
  return new MemorySessionStore(seedRecords());
}

describe('会话存储（可注入抽象）', () => {
  it('CRUD + 最近活跃排序（默认最近活跃）', () => {
    const store = new MemorySessionStore();
    const early = store.create('早期');
    const late = store.create('晚期');
    store.touch(early.id, Date.now() - 10000);
    store.touch(late.id, Date.now() - 1000);
    expect(store.list()[0].id).toBe(late.id);
    store.rename(late.id, '改名后');
    expect(store.get(late.id)?.title).toBe('改名后');
    expect(store.get(late.id)?.titleSource).toBe('manual');
    store.remove(early.id);
    expect(store.get(early.id)).toBeUndefined();
    expect(store.list().map((r) => r.id)).toEqual([late.id]);
  });

  it('持久化经注入存储回写（重开读取）', () => {
    const storage = createMemoryStorage();
    const store = createPersistentSessionStore(storage);
    store.create('持久会话');
    const rebooted = createPersistentSessionStore(storage);
    expect(rebooted.list()).toHaveLength(1);
    expect(rebooted.list()[0].title).toBe('持久会话');
  });

  it('损坏的持久化数据降级为空（不抛）', () => {
    const storage = createMemoryStorage();
    storage.setItem('inkling.sessions', '{oops');
    expect(() => createPersistentSessionStore(storage)).not.toThrow();
    expect(createPersistentSessionStore(storage).list()).toEqual([]);
  });
});

describe('标题生成（≤12 字 + 时间戳降级）', () => {
  it('正文首行截断 12 字', () => {
    expect(generateSessionTitle('请帮我整理一份关于引用质量校验规则的详细说明')).toBe('请帮我整理一份关于引用质…');
  });

  it('空内容降级时间戳', () => {
    const title = generateSessionTitle('', new Date(2026, 7, 23, 9, 30).getTime());
    expect(title).toMatch(/会话 08-23 09:30/);
  });
});

describe('会话侧栏交互', () => {
  it('按最近活跃分组渲染（今日/历史）', () => {
    const store = seededStore();
    render(<SessionList sessionStore={store} activeSessionId="s-recent" />);
    expect(screen.getByText('最近会话')).toBeInTheDocument();
    expect(screen.getByText('昨天会话')).toBeInTheDocument();
  });

  it('新建会话 → 返回 id 并激活', async () => {
    const user = userEvent.setup();
    const store = new MemorySessionStore();
    const onActivate = vi.fn();
    render(<SessionList sessionStore={store} onActivateSession={onActivate} />);
    await user.click(screen.getByText('新会话'));
    expect(store.list()).toHaveLength(1);
    expect(onActivate).toHaveBeenCalledWith(store.list()[0].id);
  });

  it('删除需二次确认', async () => {
    const user = userEvent.setup();
    const store = seededStore();
    render(<SessionList sessionStore={store} activeSessionId="" />);
    await user.click(document.querySelector('[data-ui="session_delete_btn"]') as HTMLElement);
    expect(screen.getByText(/删除「/)).toBeInTheDocument();
    await user.click(document.querySelector('[data-ui="session_delete_ok"]') as HTMLElement);
    expect(store.list()).toHaveLength(1);
  });

  it('重命名覆盖标题（titleSource=manual）', async () => {
    const user = userEvent.setup();
    const store = seededStore();
    render(<SessionList sessionStore={store} activeSessionId="" />);
    await user.click(document.querySelector('[data-ui="session_rename_btn"]') as HTMLElement);
    const input = screen.getByLabelText('会话重命名');
    await user.clear(input);
    await user.type(input, '术语表冲刺');
    await user.keyboard('{Enter}');
    expect(store.list().some((r) => r.title === '术语表冲刺')).toBe(true);
  });
});

describe('消息 hover 操作（编辑重发/由此分支 → 悬浮窗）', () => {
  it('编辑重发：悬浮窗编辑并回调', async () => {
    const user = userEvent.setup();
    const onResend = vi.fn();
    const messages: InkMessage[] = [
      { id: 'u1', kind: 'text', role: 'user', content: '原消息' },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} onResendMessage={onResend} />);
    await user.click(document.querySelector('[data-ui="msg_action_resend"]') as HTMLElement);
    expect(screen.getByRole('dialog', { name: '编辑重发' })).toBeInTheDocument();
    const textarea = document.querySelector('[data-ui="resend_draft"]') as HTMLTextAreaElement;
    await user.clear(textarea);
    await user.type(textarea, '改后的消息');
    await user.click(document.querySelector('[data-ui="resend_submit"]') as HTMLElement);
    expect(onResend).toHaveBeenCalledWith('u1', '改后的消息');
  });

  it('由此分支：注入分支接口并回调', async () => {
    const user = userEvent.setup();
    const onBranch = vi.fn();
    const branchWorkflow = { create: vi.fn().mockResolvedValue({ branchId: 'branch-x' }) };
    const action = { kind: 'branch' as const, message: { id: 'u2', kind: 'text' as const, role: 'assistant' as const, content: '目标消息' } };
    render(<MessageActionFloater action={action} onBranch={onBranch} onClose={() => undefined} branchWorkflow={branchWorkflow} />);
    expect(screen.getByRole('dialog', { name: '由此分支' })).toBeInTheDocument();
    await user.type(document.querySelector('[data-ui="branch_name"]') as HTMLInputElement, '换个评分权重');
    await user.click(document.querySelector('[data-ui="branch_submit"]') as HTMLElement);
    expect(branchWorkflow.create).toHaveBeenCalledWith('u2', '换个评分权重', undefined);
    expect(onBranch).toHaveBeenCalledWith('换个评分权重', undefined);
  });
});
