// gate: 超限(475 行) - TuiController 编排器：审批完整裁决集/视图切换/会话/事件流单文件框架骨架；随阶段 5b 功能细化按职责拆分
/**
 * TUI controller: intent/event -> state transitions + bridge call orchestration
 * (terminal IO & rendering stay outside). Deps are injected (TuiActions/TuiEvents),
 * tests can inject fakes; each frame is emitted via onFrame.
 *
 * Approval full decision set: accept / reject+reason / edit(edited_content JSON)
 * / terminate. User-visible strings come from TXT (./text.js), this file is ASCII.
 */

import { formatEvent } from './fmt.js';
import { backspaceAt, clampIndex, createModel, insertAt, pushEvent, type TuiModel } from './model.js';
import { TXT } from './text.js';
import type { ApprovalCard, EditorState, KeyName, TuiActions, TuiEvents, TuiIntent } from './types.js';
import { messageToLine } from './views.js';

export interface TuiControllerDeps {
  actions: TuiActions;
  events: TuiEvents;
  onFrame(model: TuiModel): void;
  /** Exit request (host dispose and terminal restore are done by the outer layer). */
  onExit(model: TuiModel): void;
}

export class TuiController {
  readonly model: TuiModel;
  private readonly actions: TuiActions;
  private readonly onFrame: (model: TuiModel) => void;
  private readonly onExit: (model: TuiModel) => void;
  private readonly detachEvents: () => void;
  private quit = false;

  constructor(deps: TuiControllerDeps) {
    this.model = createModel();
    this.actions = deps.actions;
    this.onFrame = deps.onFrame;
    this.onExit = deps.onExit;
    this.detachEvents = deps.events.on((line) => {
      pushEvent(this.model, { topic: line.topic, text: line.text });
      this.flush();
    });
  }

  async start(): Promise<void> {
    try {
      const sessions = await this.actions.listSessions();
      this.model.sessions = sessions;
      this.model.sessionIndex = 0;
      if (sessions.length > 0) {
        const latest = sessions[0] as NonNullable<typeof sessions[0]>;
        await this.openSession(latest.thread_id);
      }
      this.model.status = sessions.length === 0 ? TXT.noSession : '';
    } catch (error) {
      this.model.status = this.errText(error, TXT.initFail);
    }
    this.flush();
  }

  /** Unsubscribe events (host cleanup is done by outer onExit). */
  dispose(): void {
    this.detachEvents();
  }

  async onIntent(intent: TuiIntent): Promise<void> {
    if (this.quit) return;
    if (this.model.quitting) {
      this.handleQuitConfirm(intent);
      return;
    }
    if (this.model.editor !== null) {
      this.handleEditor(intent);
      return;
    }
    if (intent.kind === 'key' && intent.name === 'ctrl-c') {
      this.model.quitting = true;
      this.flush();
      return;
    }
    if (intent.kind === 'key' && intent.name === 'escape') {
      this.model.status = '';
      this.flush();
      return;
    }
    if (intent.kind === 'char') {
      await this.handleChar(intent.char);
      return;
    }
    await this.handleKey(intent.name);
  }

  /** Request exit (ctrl-c confirm / non-TTY EOF / external driver share this). */
  exit(): void {
    if (this.quit) return;
    this.quit = true;
    this.model.done = true;
    this.onExit(this.model);
  }

  async switchMode(mode: TuiModel['mode']): Promise<void> {
    this.model.mode = mode;
    this.model.status = '';
    this.model.input = '';
    this.model.cursor = 0;
    if (mode === 'approvals') {
      await this.refreshApprovals();
    }
    if (mode === 'todos') {
      await this.reloadThreadData();
    }
    this.flush();
  }

  async openSession(threadId: string): Promise<void> {
    this.model.activeThread = threadId;
    const index = this.model.sessions.findIndex((s) => s.thread_id === threadId);
    if (index >= 0) this.model.sessionIndex = index;
    this.model.mode = 'chat';
    this.model.input = '';
    this.model.cursor = 0;
    await this.reloadThreadData();
    this.model.status = `${TXT.sessionOpen}${threadId}`;
    this.flush();
  }

  async createAndOpen(): Promise<void> {
    try {
      const session = await this.actions.createSession();
      this.model.sessions = [session, ...this.model.sessions];
      this.model.sessionIndex = 0;
      await this.openSession(session.thread_id);
    } catch (error) {
      this.model.status = this.errText(error, TXT.createFail);
      this.flush();
    }
  }

  /** Non-TTY/external driver: submit a whole line as chat text (same send path). */
  async submitChat(text: string): Promise<void> {
    if (this.model.running) {
      this.model.status = TXT.busy;
      this.flush();
      return;
    }
    this.model.input = text;
    this.model.cursor = text.length;
    await this.sendInput();
  }

  async refreshApprovals(): Promise<void> {
    try {
      const approvals = await this.actions.listApprovals();
      this.model.approvals = approvals;
      if (this.model.approvalIndex >= approvals.length) {
        this.model.approvalIndex = approvals.length === 0 ? 0 : approvals.length - 1;
      }
    } catch (error) {
      this.model.status = this.errText(error, TXT.listApprovalsFail);
    }
  }

  /** Non-TTY/external driver: decide the selected approval card. */
  async resolveSelectedApproval(kind: 'accept' | 'reject' | 'edit' | 'terminate', extra?: string): Promise<void> {
    const card = this.model.approvals[this.model.approvalIndex];
    if (card === undefined) {
      this.model.status = TXT.noApprovalCard;
      this.flush();
      return;
    }
    if (kind === 'reject') {
      await this.resolveCurrent(card, 'reject', (extra ?? '').trim());
    } else if (kind === 'edit') {
      let edited: unknown;
      try {
        edited = JSON.parse(extra ?? '{}');
      } catch (error) {
        this.model.status = `${TXT.badJson}${this.errText(error, '')}`;
        this.flush();
        return;
      }
      await this.resolveCurrent(card, 'edit', edited);
    } else {
      await this.resolveCurrent(card, kind);
    }
  }

  private handleQuitConfirm(intent: TuiIntent): void {
    if (intent.kind === 'char' && (intent.char === 'y' || intent.char === 'Y')) {
      this.exit();
      return;
    }
    this.model.quitting = false;
    this.flush();
  }

  private handleEditor(intent: TuiIntent): void {
    const editor = this.model.editor as EditorState;
    if (intent.kind === 'char') {
      const next = insertAt(editor.value, editor.value.length, intent.char);
      editor.value = next.value;
      this.flush();
      return;
    }
    if (intent.name === 'backspace') {
      const next = backspaceAt(editor.value, editor.value.length);
      editor.value = next.value;
      this.flush();
      return;
    }
    if (intent.name === 'enter') {
      void this.commitEditor();
      return;
    }
    if (intent.name === 'escape' || intent.name === 'ctrl-c') {
      this.model.editor = null;
      this.model.status = '';
      this.flush();
    }
  }

  private async handleChar(char: string): Promise<void> {
    if (this.model.mode === 'chat' && this.model.input === '') {
      const digit = Number(char);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 4) {
        const modes: TuiModel['mode'][] = ['chat', 'sessions', 'todos', 'approvals'];
        await this.switchMode(modes[digit - 1] as TuiModel['mode']);
        return;
      }
    }
    if (this.model.mode === 'chat') {
      const next = insertAt(this.model.input, this.model.cursor, char);
      this.model.input = next.value;
      this.model.cursor = next.cursor;
      this.flush();
      return;
    }
    if (this.model.mode === 'sessions') {
      if (char === 'n') {
        await this.createAndOpen();
        return;
      }
      if (char === 'j' || char === 'k' || char === 'J' || char === 'K') {
        const delta = char === 'j' || char === 'J' ? 1 : -1;
        this.model.sessionIndex = clampIndex(this.model.sessionIndex, this.model.sessions.length, delta);
        this.flush();
      }
      return;
    }
    if (this.model.mode === 'approvals') {
      await this.handleApprovalChar(char);
    }
  }

  private async handleKey(name: KeyName): Promise<void> {
    switch (name) {
      case 'enter':
        await this.handleEnter();
        break;
      case 'backspace':
        if (this.model.mode === 'chat') {
          const next = backspaceAt(this.model.input, this.model.cursor);
          this.model.input = next.value;
          this.model.cursor = next.cursor;
          this.flush();
        }
        break;
      case 'down':
        this.moveSelection(1);
        break;
      case 'up':
        this.moveSelection(-1);
        break;
      case 'tab':
        this.model.status = '';
        this.flush();
        break;
      default:
        break;
    }
  }

  private moveSelection(delta: number): void {
    if (this.model.mode === 'sessions') {
      this.model.sessionIndex = clampIndex(this.model.sessionIndex, this.model.sessions.length, delta);
      this.flush();
    } else if (this.model.mode === 'approvals') {
      this.model.approvalIndex = clampIndex(this.model.approvalIndex, this.model.approvals.length, delta);
      this.flush();
    }
  }

  private async handleEnter(): Promise<void> {
    if (this.model.mode === 'sessions') {
      const target = this.model.sessions[this.model.sessionIndex];
      if (target !== undefined) await this.openSession(target.thread_id);
      return;
    }
    if (this.model.mode === 'todos') {
      await this.switchMode('chat');
      return;
    }
    if (this.model.mode === 'chat') {
      await this.sendInput();
    }
  }

  private async handleApprovalChar(char: string): Promise<void> {
    const card = this.model.approvals[this.model.approvalIndex];
    if (char === 'j' || char === 'k' || char === 'J' || char === 'K') {
      const delta = char === 'j' || char === 'J' ? 1 : -1;
      this.model.approvalIndex = clampIndex(this.model.approvalIndex, this.model.approvals.length, delta);
      this.flush();
      return;
    }
    if (card === undefined) return;
    switch (char) {
      case 'a':
        await this.resolveCurrent(card, 'accept');
        break;
      case 'r':
        this.openEditor('reason', `${TXT.rejectTitle}${card.key}${TXT.rejectTail}`);
        break;
      case 'e':
        this.openEditor('edit', `${TXT.editTitle}${card.key}${TXT.editTail}`);
        break;
      case 't':
        await this.resolveCurrent(card, 'terminate');
        break;
      default:
        break;
    }
  }

  private openEditor(kind: EditorState['kind'], title: string): void {
    this.model.editor = { kind, title, value: '' };
    this.flush();
  }

  private async commitEditor(): Promise<void> {
    const editor = this.model.editor as EditorState;
    this.model.editor = null;
    const card = this.model.approvals[this.model.approvalIndex];
    if (card === undefined) return;
    if (editor.kind === 'reason') {
      await this.resolveCurrent(card, 'reject', editor.value.trim());
    } else {
      let edited: unknown;
      try {
        edited = JSON.parse(editor.value);
      } catch (error) {
        this.model.status = `${TXT.badJson}${this.errText(error, '')}`;
        this.flush();
        return;
      }
      await this.resolveCurrent(card, 'edit', edited);
    }
  }

  private async resolveCurrent(card: ApprovalCard, decision: string, extra?: unknown): Promise<void> {
    this.model.status = `${TXT.resolving}${card.key} -> ${decision}...`;
    this.flush();
    try {
      const payload =
        decision === 'reject'
          ? { decision: 'reject', reason: typeof extra === 'string' ? extra : '' }
          : decision === 'edit'
            ? { decision: 'edit', edited_content: extra }
            : { decision };
      await this.actions.resolveApproval(card.thread_id, payload);
      const extraText = decision === 'reject' && typeof extra === 'string' && extra !== '' ? `?${extra}?` : '';
      pushEvent(this.model, {
        topic: 'tui.approval',
        text: `${TXT.approvalArrow}${card.key} -> ${decision}${extraText}`,
      });
      this.model.status = `${TXT.resolved}${card.key} -> ${decision}`;
    } catch (error) {
      this.model.status = this.errText(error, `${TXT.resolving}${card.key} ${TXT.failTail}`);
    }
    await this.refreshApprovals();
    if (card.thread_id === this.model.activeThread) {
      await this.reloadThreadData();
    }
    this.flush();
  }

  private async sendInput(): Promise<void> {
    const text = this.model.input.trim();
    if (text === '') return;
    if (this.model.running) {
      this.model.status = TXT.busy;
      this.flush();
      return;
    }
    let thread = this.model.activeThread;
    if (thread === null) {
      try {
        const session = await this.actions.createSession();
        this.model.sessions = [session, ...this.model.sessions];
        thread = session.thread_id;
        this.model.activeThread = thread;
        this.model.sessionIndex = 0;
      } catch (error) {
        this.model.status = this.errText(error, TXT.createOnSendFail);
        this.flush();
        return;
      }
    }
    this.model.input = '';
    this.model.cursor = 0;
    this.model.running = true;
    pushEvent(this.model, { topic: 'tui.send', text: `${TXT.arrow} ${text}` });
    this.model.status = TXT.sending;
    this.flush();
    try {
      await this.actions.send(thread, text);
      pushEvent(this.model, { topic: 'tui.round', text: TXT.roundDone });
      this.model.status = TXT.roundDone;
    } catch (error) {
      this.model.status = this.errText(error, TXT.sendFail);
    } finally {
      this.model.running = false;
      if (thread === this.model.activeThread) await this.reloadThreadData();
      await this.refreshApprovals();
      this.flush();
    }
  }

  private async reloadThreadData(): Promise<void> {
    const thread = this.model.activeThread;
    if (thread === null) {
      this.model.messages = [];
      this.model.todoLines = [];
      return;
    }
    try {
      const rows = await this.actions.listMessages(thread);
      this.model.messages = rows.map(messageToLine);
    } catch (error) {
      this.model.status = this.errText(error, TXT.readMessagesFail);
    }
    try {
      const todo = await this.actions.listTodos(thread);
      this.model.todoLines = this.todoToLines(todo);
    } catch {
      this.model.todoLines = [];
    }
  }

  private todoToLines(todo: unknown): string[] {
    if (typeof todo !== 'object' || todo === null) return [];
    const record = todo as Record<string, unknown>;
    const pending = Array.isArray(record.pending) ? record.pending : null;
    if (pending === null) {
      return [formatEvent('tui.todos', todo)];
    }
    if (pending.length === 0) return [];
    return pending.map((step, index) => {
      if (typeof step === 'object' && step !== null) {
        const row = step as Record<string, unknown>;
        const label = typeof row.title === 'string' ? row.title : formatEvent('step', row);
        return `${index + 1}. ${label}`;
      }
      return `${index + 1}. ${String(step)}`;
    });
  }

  private errText(error: unknown, prefix: string): string {
    const message = error instanceof Error ? error.message : String(error);
    return prefix === '' ? message : `${prefix}: ${message}`;
  }

  private flush(): void {
    this.onFrame(this.model);
  }
}
