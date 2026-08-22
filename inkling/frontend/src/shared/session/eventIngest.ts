/**
 * 事件落位（ingest）：引擎事件 → 会话状态（消息流/审批卡/推演/孵化/补丁链）。
 *
 * 纯函数式归约：每个事件类型一个处理分支，写入 ChannelHub；组件不感知
 * 传输细节，只消费 state.* 与 events.* 通道。未知事件类型不崩（折叠兜底）。
 */

import { BatchCounter } from '../logger';
import type { ChannelHub, HubEvent } from './channelHub';
import type { InkMessage } from './types';

let messageSeq = 0;

function nextId(): string {
  messageSeq += 1;
  return `m-${Date.now()}-${messageSeq}`;
}

/** 查找消息流中 (stepId, roundId) 精确匹配的消息（roundId 空则仅匹配 stepId）。 */
function findStep(
  messages: InkMessage[],
  stepId: string,
  roundId: string | undefined,
): InkMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.stepId === stepId && (roundId === undefined || m.roundId === roundId)) return m;
  }
  return undefined;
}

/**
 * 事件 → 会话状态归约。token 流按批聚合（BatchCounter），
 * 批次写入单条 streaming 消息，避免逐 token 重渲。
 */
export function ingestEvent(hub: ChannelHub, event: HubEvent): void {
  const { type, payload, at } = event;
  const state = hub.getSnapshot();
  const roundId = (payload.round_id as string | undefined) ?? state.roundId ?? undefined;
  const stepId = (payload.step_id as string | undefined) ?? '';

  let messages = state.messages;
  let next: Partial<typeof state> = {};

  const upsert = (create: InkMessage, patch: (m: InkMessage) => InkMessage): void => {
    const found = findStep(messages, stepId, roundId);
    messages = found
      ? messages.map((m) => (m === found ? patch(m) : m))
      : [...messages, { ...create, id: nextId(), stepId: stepId || undefined, roundId }];
  };

  switch (type) {
    case 'reply_token': {
      const token = String(payload.token ?? '');
      if (!token) break;
      const found = findStep(messages, stepId, roundId);
      const content = (found && found.kind === 'streaming' ? found.content : '') + token;
      if (found && found.kind === 'streaming') {
        messages = messages.map((m) => (m === found ? { ...m, content } : m));
      } else {
        messages = [...messages, { kind: 'streaming', content, id: nextId(), stepId: stepId || undefined, roundId }];
      }
      break;
    }
    case 'thinking_start':
      upsert(
        { kind: 'thinking', content: '', status: 'running', id: nextId() },
        (m) => (m.kind === 'thinking' ? { ...m, status: 'running' as const } : m),
      );
      break;
    case 'thinking_end':
      upsert(
        { kind: 'thinking', content: String(payload.content ?? ''), status: 'completed', id: nextId() },
        (m) => (m.kind === 'thinking' ? { ...m, status: 'completed' as const, content: String(payload.content ?? m.content) } : m),
      );
      break;
    case 'plan_start':
      upsert(
        { kind: 'plan', content: '', status: 'running', id: nextId(), workflow: payload.workflow as string | undefined },
        (m) => (m.kind === 'plan' ? { ...m, status: 'running' as const, workflow: payload.workflow as string | undefined } : m),
      );
      break;
    case 'plan_end':
      upsert(
        { kind: 'plan', content: String(payload.content ?? ''), status: 'completed', id: nextId() },
        (m) => (m.kind === 'plan' ? { ...m, status: 'completed' as const } : m),
      );
      break;
    case 'tool_start': {
      const tool = String(payload.tool ?? payload.tool_name ?? '');
      if (!tool) break;
      upsert(
        { kind: 'tool', tool, permission: String(payload.permission ?? ''), toolStatus: 'running', id: nextId() },
        (m) =>
          m.kind === 'tool'
            ? { ...m, tool, permission: String(payload.permission ?? m.permission), toolStatus: 'running' as const }
            : m,
      );
      break;
    }
    case 'tool_end': {
      const tool = String(payload.tool ?? payload.tool_name ?? '');
      const summary = String(payload.summary ?? payload.result_preview ?? '');
      upsert(
        {
          kind: 'tool',
          tool,
          permission: '',
          toolStatus: payload.success === false ? 'error' : 'done',
          summary,
          id: nextId(),
        },
        (m) =>
          m.kind === 'tool'
            ? {
                ...m,
                toolStatus: payload.success === false ? ('error' as const) : ('done' as const),
                summary: summary || m.summary,
              }
            : m,
      );
      break;
    }
    case 'spawn_start':
      upsert(
        {
          kind: 'spawn',
          nodeId: payload.node_id as string | undefined,
          label: payload.label as string | undefined,
          status: 'running',
          id: nextId(),
        },
        (m) => (m.kind === 'spawn' ? { ...m, status: 'running' as const } : m),
      );
      break;
    case 'spawn_end':
      upsert(
        { kind: 'spawn', nodeId: payload.node_id as string | undefined, status: 'completed', id: nextId() },
        (m) => (m.kind === 'spawn' ? { ...m, status: 'completed' as const } : m),
      );
      break;
    case 'review_card': {
      messages = [...messages, { kind: 'review_card', payload: { ...payload }, live: true, id: nextId(), stepId: stepId || undefined, roundId }];
      next.pendingReview = { ...payload };
      break;
    }
    case 'suggestions': {
      const items = Array.isArray(payload.items) ? payload.items.map(String) : [];
      messages = [...messages, { kind: 'suggestions', items, id: nextId(), stepId: stepId || undefined, roundId }];
      break;
    }
    case 'error':
      messages = [...messages, { kind: 'error', content: String(payload.message ?? ''), id: nextId(), stepId: stepId || undefined, roundId }];
      break;
    case 'memory_recall': {
      const hits = Array.isArray(payload.hits)
        ? payload.hits.map((h) => {
            const hit = h as Record<string, unknown>;
            return {
              id: String(hit.id ?? ''),
              title: String(hit.title ?? ''),
              snippet: String(hit.snippet ?? ''),
            };
          })
        : [];
      if (hits.length > 0) {
        messages = [...messages, { kind: 'knowledge_hit', hits, id: nextId(), stepId: stepId || undefined, roundId }];
      }
      const traces = [...state.sourceTraces];
      for (const hit of hits) {
        traces.push({
          id: nextId(),
          sourceType: 'memory',
          title: hit.title,
          detail: hit.snippet,
          knowledgeId: hit.id,
          createdAt: at,
        });
      }
      next.sourceTraces = traces;
      break;
    }
    case 'device_perception':
    case 'device_control': {
      const action = String(payload.action ?? type);
      messages = [...messages, { kind: 'device', action, detail: String(payload.detail ?? payload.result ?? ''), id: nextId(), stepId: stepId || undefined, roundId }];
      const traces = [...state.sourceTraces];
      traces.push({ id: nextId(), sourceType: 'device', title: action, detail: String(payload.detail ?? ''), createdAt: at });
      next.sourceTraces = traces;
      break;
    }
    case 'signal_observed': {
      const incubation = [...state.incubation];
      incubation.push({
        id: String(payload.signal_id ?? nextId()),
        signal: String(payload.signal ?? ''),
        signalType: String(payload.signal_type ?? ''),
        stage: 'signal',
        createdAt: at,
      });
      next.incubation = incubation;
      break;
    }
    case 'distill_result': {
      const incubation = state.incubation.map((entry) =>
        entry.id === payload.signal_id
          ? { ...entry, stage: 'distilled' as const, distilled: String(payload.distilled ?? '') }
          : entry,
      );
      next.incubation = incubation;
      break;
    }
    case 'gate_verdict': {
      const incubation = state.incubation.map((entry) =>
        entry.id === payload.signal_id
          ? {
              ...entry,
              stage: payload.passed === true ? ('passed' as const) : ('blocked' as const),
              verdict: String(payload.reason ?? ''),
              gateLevel: String(payload.level ?? ''),
            }
          : entry,
      );
      next.incubation = incubation;
      break;
    }
    case 'simulate_decision': {
      const branches = Array.isArray(payload.branches)
        ? payload.branches.map((b, index) => {
            const branch = b as Record<string, unknown>;
            return {
              branchId: String(branch.branch_id ?? `b${index + 1}`),
              label: String(branch.label ?? `分支 ${index + 1}`),
              score: Number(branch.score ?? 0),
              rationale: branch.rationale as string | undefined,
              steps: Array.isArray(branch.steps) ? (branch.steps as Array<{ node: string; status: string; note?: string }>) : [],
              selected: branch.selected === true || index === 0,
            };
          })
        : [];
      next.simulations = branches;
      break;
    }
    case 'branch_result':
      next.simulations = state.simulations.map((branch) =>
        branch.branchId === payload.branch_id
          ? { ...branch, score: Number(payload.score ?? branch.score), rationale: payload.rationale as string | undefined }
          : branch,
      );
      break;
    case 'swap_branch':
      next.simulations = state.simulations.map((branch) => ({
        ...branch,
        selected: branch.branchId === payload.branch_id,
      }));
      break;
    case 'mutation_proposed': {
      const incubation = [...state.incubation];
      incubation.push({
        id: String(payload.mutation_id ?? nextId()),
        signal: String(payload.mutation ?? ''),
        signalType: 'mutation',
        stage: 'distilled',
        createdAt: at,
      });
      next.incubation = incubation;
      break;
    }
    case 'regression_guard': {
      const incubation = state.incubation.map((entry) =>
        entry.id === payload.mutation_id
          ? {
              ...entry,
              stage: payload.passed === true ? ('passed' as const) : ('blocked' as const),
              verdict: String(payload.reason ?? ''),
              gateLevel: 'guard',
            }
          : entry,
      );
      next.incubation = incubation;
      break;
    }
    case 'patch_proposed': {
      const patchChain = [...state.patchChain];
      patchChain.push({
        patchId: String(payload.patch_id ?? nextId()),
        kind: String(payload.kind ?? ''),
        title: String(payload.title ?? payload.kind ?? ''),
        status: 'proposed',
        level: payload.level as string | undefined,
      });
      next.patchChain = patchChain;
      break;
    }
    case 'patch_applied':
      next.patchChain = state.patchChain.map((entry) =>
        entry.patchId === payload.patch_id
          ? { ...entry, status: 'applied' as const, appliedAt: at }
          : entry,
      );
      break;
    case 'patch_reverted':
      next.patchChain = state.patchChain.map((entry) =>
        entry.patchId === payload.patch_id
          ? { ...entry, status: 'reverted' as const, revertedAt: at, revertReason: String(payload.reason ?? '') }
          : entry,
      );
      break;
    case 'vetting_result': {
      const traces = [...state.sourceTraces];
      traces.push({
        id: nextId(),
        sourceType: 'evidence',
        title: `vetting：${String(payload.tool ?? payload.target ?? '')}`,
        detail: payload.passed === true ? '静态钩子核对通过' : `拦截：${String(payload.reason ?? '')}`,
        createdAt: at,
      });
      next.sourceTraces = traces;
      break;
    }
    case 'tuning_applied': {
      const traces = [...state.sourceTraces];
      traces.push({
        id: nextId(),
        sourceType: 'evidence',
        title: '调优应用',
        detail: String(payload.detail ?? ''),
        createdAt: at,
      });
      next.sourceTraces = traces;
      break;
    }
    case 'end':
      // 回合结束信号：不建卡（消息流/指标已承载），仅推进状态
      break;
    default:
      // 未落位的事件类型：折叠兜底卡（不崩，展示原始负载）
      messages = [...messages, { kind: 'unknown', token: JSON.stringify(event), id: nextId(), stepId: stepId || undefined, roundId }];
  }

  hub.setState({ ...next, messages, roundId: state.roundId ?? roundId });
}

/**
 * 会话驱动：从事件源（SSE/夹具脚本）逐条 ingest。
 * 批次指标在事件流结束后统一输出（避免逐事件噪音）。
 */
export function createIngester(hub: ChannelHub): (event: HubEvent) => void {
  const counter = new BatchCounter('session', '事件流批次');
  return (event) => {
    counter.add(event.type, event.type === 'reply_token' ? String(event.payload.token ?? '').length : 0);
    ingestEvent(hub, event);
  };
}

/** 回合流式状态（事件驱动侧维护，组件只读消费）。 */
export function setStreaming(hub: ChannelHub, streaming: boolean): void {
  hub.setState({ streaming });
}

/**
 * 流式回复定型（回合 end 时驱动侧调用）：把回合内残留的 streaming 行
 * 提交为正式 text/assistant 消息——消除永久闪烁光标（流式中途离开的语义）。
 */
export function commitStreaming(hub: ChannelHub, at = Date.now()): void {
  void at;
  const snapshot = hub.getSnapshot();
  if (!snapshot.messages.some((m) => m.kind === 'streaming')) return;
  const messages = snapshot.messages.map((m) =>
    m.kind === 'streaming' ? { ...m, kind: 'text' as const, role: 'assistant' as const } : m,
  );
  hub.setState({ ...snapshot, messages, streaming: false });
}

/**
 * 用户输入提交（会话驱动侧本地动作）：message_list 的用户气泡 + 演示占位回复。
 * 集成期此处由引擎回合接管（该路径不产生引擎事件，仅落位本地面）。
 */
export function submitUserMessage(hub: ChannelHub, text: string, at = Date.now()): void {
  const snapshot = hub.getSnapshot();
  if (snapshot.streaming) return;
  const roundId = snapshot.roundId ?? `round-${at}`;
  const userMsg: InkMessage = { kind: 'text', role: 'user', content: text, id: nextId(), roundId };
  const reply: InkMessage = {
    kind: 'text',
    role: 'assistant',
    content: `收到：「${text}」。演示形态下回合由夹具事件驱动；集成期此处为引擎回合入口（route → tools → review → reply）。`,
    id: nextId(),
    roundId,
  };
  hub.setState({ ...snapshot, messages: [...snapshot.messages, userMsg, reply], roundId });
}

export function setGear(hub: ChannelHub, activeGear: Parameters<ChannelHub['setState']>[0]['activeGear']): void {
  hub.setState({ activeGear });
}

export function setModeTier(hub: ChannelHub, modeTier: Parameters<ChannelHub['setState']>[0]['modeTier']): void {
  hub.setState({ modeTier });
}
