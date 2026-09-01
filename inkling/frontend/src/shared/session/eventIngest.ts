/**
 * 事件落位（ingest）：引擎事件 → 会话状态（消息流/审批卡/推演/孵化/补丁链）。
 *
 * 纯函数式归约：每个事件类型一个处理分支，写入 ChannelHub；组件不感知
 * 传输细节，只消费 state.* 与 events.* 通道。未知事件类型不崩（折叠兜底）。
 */

import { BatchCounter } from '../logger';
import type { ChannelHub, HubEvent, ThreadBucket } from './channelHub';
import { emptyThreadBucket } from './channelHub';
import type { InkMessage, OutboundAttachment, RoundStep } from './types';
import { reduceTaskEvent } from './taskState';
import { getUiStateStore } from '../ui/uiStateStore';
import { DEV_MODE_KEY } from '../ui/devMode';
import type { EventTypeName } from './eventTypes';

let messageSeq = 0;

function nextId(): string {
  messageSeq += 1;
  return `m-${Date.now()}-${messageSeq}`;
}

/** streaming 超时兜底：无 reply_token 更新超时后自动定型，防永久闪烁。 */
const STREAMING_TIMEOUT_MS = 30_000;

/** sourceTraces 容量上限：超限截尾保留最近 N 条，防长会话无限增长。 */
const SOURCE_TRACES_MAX = 200;

/**
 * 引擎事件（EngineEvent.to_dict 信封）→ HubEvent 归一。
 * 引擎把 round_id/step_id 放信封顶层，前端归约从 payload 读取——
 * 归一注入 payload，与夹具/绑定协议形态统一；未登记类型原样透传
 * （ingest 默认分支折叠兜底，不崩）。
 */
export function toHubEvent(raw: Record<string, unknown>): HubEvent {
  const rawPayload = (raw.payload && typeof raw.payload === 'object'
    ? (raw.payload as Record<string, unknown>)
    : {});
  const payload: Record<string, unknown> = { ...rawPayload };
  // 信封字段原样透传（引擎 events.to_dict 顶层字段，供前端隔离/续流用）
  const envelopeKeys = ['thread_id', 'seq', 'parent_step_id', 'node', 'graph_path', 'trace_id', 'version'] as const;
  for (const key of envelopeKeys) {
    const value = raw[key];
    if (value !== undefined && value !== null) payload[key] = value as string | number | unknown;
  }
  if (raw.round_id !== undefined && raw.round_id !== null) payload.round_id = raw.round_id;
  if (raw.step_id !== undefined && raw.step_id !== null) payload.step_id = raw.step_id;
  const rawType = typeof raw.type === 'string' ? raw.type : 'unknown';
  return { type: rawType as EventTypeName, payload, at: Date.now() };
}

/** 工具原始参数整理：对象/数组 → 格式化 JSON 文本（供展开查看，不裸 JSON）。 */
function normalizeToolArgs(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw.trim() || undefined;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return undefined;
  }
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
 *
 * 按 thread_id 分桶：演化/推演/来源时间线/补丁链等回合状态归约进
 * 对应会话窗口的桶（perThread），消息流与全局镜像只反映当前会话——
 * 切换会话窗口后各 tab 显示各自会话的数据，不跨会话残留。
 */
export function ingestEvent(hub: ChannelHub, event: HubEvent): void {
  const { type, payload, at } = event;
  const state = hub.getSnapshot();
  // 目标线程：事件携带真实 thread_id 归入该会话桶；系统事件（'-'/缺失）
  // 归入当前会话桶（非会话专属，始终落位当前窗口）。
  const eventThread = typeof payload.thread_id === 'string' ? payload.thread_id : '';
  const activeThread = state.activeSessionId;
  const targetThread = eventThread && eventThread !== '-' ? eventThread : activeThread;
  const isActive = targetThread === activeThread;
  const bucket = state.perThread[targetThread] ?? emptyThreadBucket();
  const roundId = (payload.round_id as string | undefined) ?? bucket.roundId ?? undefined;
  const stepId = (payload.step_id as string | undefined) ?? '';
  // 任务面事件归约（task_state 子通道）；非任务事件归约为原样（不崩）
  const taskState = reduceTaskEvent(state.taskState, event);

  let messages = state.messages;
  let next: Partial<typeof state> = {};
  // 桶内回合状态（归约目标 = 对应会话窗口）
  let roundSteps = bucket.roundSteps;
  let simulations = bucket.simulations;
  let incubation = bucket.incubation;
  let sourceTraces = bucket.sourceTraces;
  let patchChain = bucket.patchChain;
  const nextRoundId = bucket.roundId ?? roundId ?? null;

  const upsert = (create: InkMessage, patch: (m: InkMessage) => InkMessage): void => {
    const found = findStep(messages, stepId, roundId);
    messages = found
      ? messages.map((m) => (m === found ? patch(m) : m))
      : [...messages, { ...create, id: nextId(), stepId: stepId || undefined, roundId }];
  };

  /** 回合步骤累积（stepId 稳定 upsert；与引擎 core.round_steps 语义对齐）。 */
  const upsertStep = (create: Omit<RoundStep, 'startedAt'>, patch: (s: RoundStep) => RoundStep): void => {
    const sid = create.stepId || stepId || `${create.type}:${roundSteps.length + 1}`;
    const idx = roundSteps.findIndex((s) => s.stepId === sid);
    roundSteps = idx >= 0
      ? roundSteps.map((s, i) => (i === idx ? patch(s) : s))
      : [...roundSteps, { ...create, stepId: sid, startedAt: at }];
  };

  switch (type) {
    case 'user_message': {
      // 回合边界：重置本回合步骤序列并落位用户步（消息气泡由提交侧本地落位）。
      roundSteps = [{ stepId: 'user', type: 'user', label: '用户', status: 'done', startedAt: at }];
      break;
    }
    case 'reply_token': {
      const token = String(payload.token ?? '');
      if (!token) break;
      // 发言人身份透传（协作者 reply_token 携带 name；主 agent 无）
      const speaker = typeof payload.name === 'string' && payload.name ? payload.name : undefined;
      const found = findStep(messages, stepId, roundId);
      const content = (found && found.kind === 'streaming' ? found.content : '') + token;
      if (found && found.kind === 'streaming') {
        messages = messages.map((m) =>
          m === found ? { ...m, content, ...(speaker ? { name: speaker } : {}) } : m,
        );
      } else {
        messages = [
          ...messages,
          {
            kind: 'streaming',
            content,
            id: nextId(),
            stepId: stepId || undefined,
            roundId,
            ...(speaker ? { name: speaker } : {}),
          },
        ];
      }
      break;
    }
    case 'thinking_start': {
      upsertStep({ stepId, type: 'thinking', label: '思考', status: 'running' }, (s) => ({ ...s, status: 'running' as const }));
      // 思考流式：同 stepId 的 thinking_start 携带 content 分片时在正在
      // 进行的思考条目上逐片追加（中途逐步可见）；无分片 = 仅开启条目。
      const chunk = String(payload.content ?? '');
      const found = findStep(messages, stepId, roundId);
      if (found && found.kind === 'thinking') {
        messages = messages.map((m) =>
          m === found ? { ...m, content: m.content + chunk, status: 'running' as const } : m,
        );
      } else {
        upsert(
          { kind: 'thinking', content: chunk, status: 'running', id: nextId() },
          (m) => (m.kind === 'thinking' ? { ...m, content: chunk ? m.content + chunk : m.content, status: 'running' as const } : m),
        );
      }
      break;
    }
    case 'thinking_end':
      upsertStep({ stepId, type: 'thinking', label: '思考', status: 'done' }, (s) => ({ ...s, status: 'done' as const }));
      upsert(
        { kind: 'thinking', content: String(payload.content ?? ''), status: 'completed', id: nextId() },
        (m) => (m.kind === 'thinking' ? { ...m, status: 'completed' as const, content: String(payload.content ?? m.content) } : m),
      );
      break;
    case 'plan_start':
      upsertStep({ stepId, type: 'plan', label: '计划', status: 'running' }, (s) => ({ ...s, status: 'running' as const }));
      // 引擎发射 {plan: [{nodes:[...]}]}（graph_recipe 计划步），取步骤名作展示标签。
      {
        const rawPlan = payload.plan ?? payload.workflow;
        const workflow = Array.isArray(rawPlan)
          ? rawPlan
              .map((step) => {
                const s = step as { nodes?: unknown };
                const nodes = Array.isArray(s.nodes) ? s.nodes.map(String).join('→') : '';
                return nodes;
              })
              .filter(Boolean)
              .join(', ') || undefined
          : typeof rawPlan === 'string'
            ? rawPlan
            : undefined;
        upsert(
          { kind: 'plan', content: '', status: 'running', id: nextId(), workflow },
          (m) => (m.kind === 'plan' ? { ...m, status: 'running' as const, workflow } : m),
        );
      }
      break;
    case 'plan_end':
      upsertStep({ stepId, type: 'plan', label: '计划', status: 'done' }, (s) => ({ ...s, status: 'done' as const }));
      upsert(
        { kind: 'plan', content: String(payload.content ?? ''), status: 'completed', id: nextId() },
        (m) => (m.kind === 'plan' ? { ...m, status: 'completed' as const } : m),
      );
      break;
    case 'plan_token': {
      // 规划流式增量（seed schema: token）——追加到运行中的 plan 卡内容
      const token = String(payload.token ?? '');
      if (!token) break;
      const found = findStep(messages, stepId, roundId);
      if (found && found.kind === 'plan') {
        messages = messages.map((m) =>
          m === found ? { ...m, content: m.content + token, status: 'running' as const } : m,
        );
      } else {
        upsert(
          { kind: 'plan', content: token, status: 'running', id: nextId() },
          (m) => (m.kind === 'plan' ? { ...m, content: m.content + token, status: 'running' as const } : m),
        );
      }
      break;
    }
    case 'tool_start': {
      const tool = String(payload.tool ?? payload.tool_name ?? '');
      if (!tool) break;
      const args = normalizeToolArgs(payload.args ?? payload.parameters);
      // 展示名通道：seed schema 为 summary；兼容历史 title 通道（测试/旧
      // 事件形态），两者均缺省时回落原始工具名
      const title =
        (typeof payload.summary === 'string' && payload.summary.trim() !== '' ? payload.summary : undefined) ??
        (typeof payload.title === 'string' && payload.title.trim() !== '' ? payload.title : undefined);
      upsertStep(
        { stepId, type: 'tool', label: title ?? tool, status: 'running' },
        (s) => ({ ...s, label: title ?? s.label ?? tool, status: 'running' as const }),
      );
      upsert(
        { kind: 'tool', tool, title, permission: String(payload.permission ?? ''), toolStatus: 'running', id: nextId(), args },
        (m) =>
          m.kind === 'tool'
            ? {
                ...m,
                tool,
                title: title ?? m.title,
                permission: String(payload.permission ?? m.permission),
                toolStatus: 'running' as const,
                args: args || m.args,
              }
            : m,
      );
      break;
    }
    case 'tool_end': {
      const tool = String(payload.tool ?? payload.tool_name ?? '');
      const summary = String(payload.summary ?? payload.result_preview ?? '');
      const failed = payload.success === false;
      upsertStep(
        { stepId, type: 'tool', label: tool, status: failed ? 'error' : 'done' },
        (s) => ({ ...s, label: s.label ?? tool, status: failed ? ('error' as const) : ('done' as const) }),
      );
      upsert(
        {
          kind: 'tool',
          tool,
          permission: '',
          toolStatus: failed ? 'error' : 'done',
          summary,
          id: nextId(),
        },
        (m) =>
          m.kind === 'tool'
            ? {
                ...m,
                toolStatus: failed ? ('error' as const) : ('done' as const),
                summary: summary || m.summary,
              }
            : m,
      );
      break;
    }
    case 'spawn_start': {
      // 引擎发射 {spawns: [{id, nodes[], parallel, label}]}（展示形态）；
      // 展示标签取首个分组的 label/id，节点关联取首个分组 id
      const spawns = Array.isArray(payload.spawns) ? (payload.spawns as Array<Record<string, unknown>>) : [];
      const first = spawns[0] ?? {};
      const spawnLabel = typeof first.label === 'string' && first.label.trim() !== ''
        ? first.label
        : (typeof payload.label === 'string' ? payload.label : undefined);
      const spawnId = typeof first.id === 'string' && first.id.trim() !== ''
        ? first.id
        : (typeof payload.spawn_id === 'string' ? payload.spawn_id : undefined);
      upsertStep(
        { stepId, type: 'spawn', label: String(spawnLabel ?? spawnId ?? '子代理'), status: 'running' },
        (s) => ({ ...s, status: 'running' as const }),
      );
      upsert(
        {
          kind: 'spawn',
          nodeId: spawnId ?? (payload.node_id as string | undefined),
          label: spawnLabel as string | undefined,
          status: 'running',
          id: nextId(),
        },
        (m) => (m.kind === 'spawn' ? { ...m, status: 'running' as const } : m),
      );
      break;
    }
    case 'spawn_end':
      upsertStep({ stepId, type: 'spawn', label: '子代理', status: 'completed' }, (s) => ({ ...s, status: 'completed' as const }));
      upsert(
        { kind: 'spawn', nodeId: payload.node_id as string | undefined, status: 'completed', id: nextId() },
        (m) => (m.kind === 'spawn' ? { ...m, status: 'completed' as const } : m),
      );
      break;
    case 'review_card': {
      upsertStep({ stepId, type: 'review', label: '审批', status: 'running' }, (s) => ({ ...s, status: 'running' as const }));
      messages = [...messages, { kind: 'review_card', payload: { ...payload }, live: true, id: nextId(), stepId: stepId || undefined, roundId }];
      if (isActive) next.pendingReview = { ...payload };
      break;
    }
    case 'suggestions': {
      const items = Array.isArray(payload.items) ? payload.items.map(String) : [];
      messages = [...messages, { kind: 'suggestions', items, id: nextId(), stepId: stepId || undefined, roundId }];
      break;
    }
    case 'error':
      upsertStep({ stepId, type: 'error', label: '错误', status: 'error' }, (s) => ({ ...s, status: 'error' as const }));
      messages = [...messages, {
        kind: 'error',
        content: String(payload.message ?? ''),
        node: payload.node ? String(payload.node) : undefined,
        id: nextId(),
        stepId: stepId || undefined,
        roundId,
      }];
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
      const traces = [...sourceTraces];
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
      sourceTraces = traces.slice(-SOURCE_TRACES_MAX);
      break;
    }
    case 'device_sensed':
    case 'device_control': {
      const action = String(payload.action ?? type);
      messages = [...messages, { kind: 'device', action, detail: String(payload.detail ?? payload.result ?? ''), id: nextId(), stepId: stepId || undefined, roundId }];
      const traces = [...sourceTraces];
      traces.push({ id: nextId(), sourceType: 'device', title: action, detail: String(payload.detail ?? ''), createdAt: at });
      sourceTraces = traces.slice(-SOURCE_TRACES_MAX);
      break;
    }
    case 'signal_detected': {
      const list = [...incubation];
      list.push({
        id: String(payload.signal_id ?? nextId()),
        signal: String(payload.signal ?? ''),
        signalType: String(payload.signal_type ?? ''),
        stage: 'signal',
        createdAt: at,
      });
      incubation = list;
      break;
    }
    case 'distill_outcome': {
      incubation = incubation.map((entry) =>
        entry.id === payload.signal_id
          ? { ...entry, stage: 'distilled' as const, distilled: String(payload.distilled ?? '') }
          : entry,
      );
      break;
    }
    case 'gate_verdict': {
      incubation = incubation.map((entry) =>
        entry.id === payload.signal_id
          ? {
              ...entry,
              stage: payload.passed === true ? ('passed' as const) : ('blocked' as const),
              verdict: String(payload.reason ?? ''),
              gateLevel: String(payload.level ?? ''),
            }
          : entry,
      );
      break;
    }
    case 'simulate_decision': {
      // 引擎实际发射（executor simulate 决策留痕）：branches = [{index,
      // description, score, passed, note}]，selected = 选中分支索引数组。
      const selectedIdx = Array.isArray(payload.selected) ? (payload.selected as unknown[]) : [];
      const branches = Array.isArray(payload.branches)
        ? payload.branches.map((b, index) => {
            const branch = b as Record<string, unknown>;
            return {
              branchId: String(branch.branch_id ?? branch.index ?? `b${index + 1}`),
              label: String(branch.label ?? branch.description ?? `分支 ${index + 1}`),
              score: Number(branch.score ?? 0),
              rationale: (branch.rationale ?? branch.note) as string | undefined,
              steps: Array.isArray(branch.steps) ? (branch.steps as Array<{ node: string; status: string; note?: string }>) : [],
              selected:
                selectedIdx.includes(branch.index) ||
                (branch.selected === true) ||
                (selectedIdx.length === 0 && index === 0),
            };
          })
        : [];
      simulations = branches;
      break;
    }
    case 'branch_result':
      simulations = simulations.map((branch) =>
        branch.branchId === payload.branch_id
          ? { ...branch, score: Number(payload.score ?? branch.score), rationale: payload.rationale as string | undefined }
          : branch,
      );
      break;
    case 'swap_branch':
      simulations = simulations.map((branch) => ({
        ...branch,
        selected: branch.branchId === payload.branch_id,
      }));
      break;
    case 'mutation_proposed': {
      const list = [...incubation];
      list.push({
        id: String(payload.mutation_id ?? nextId()),
        signal: String(payload.mutation ?? ''),
        signalType: 'mutation',
        stage: 'distilled',
        createdAt: at,
      });
      incubation = list;
      break;
    }
    case 'regression_guard': {
      incubation = incubation.map((entry) =>
        entry.id === payload.mutation_id
          ? {
              ...entry,
              stage: payload.passed === true ? ('passed' as const) : ('blocked' as const),
              verdict: String(payload.reason ?? ''),
              gateLevel: 'guard',
            }
          : entry,
      );
      break;
    }
    case 'patch_proposed': {
      const chain = [...patchChain];
      chain.push({
        patchId: String(payload.patch_id ?? nextId()),
        kind: String(payload.kind ?? ''),
        title: String(payload.title ?? payload.kind ?? ''),
        status: 'proposed',
        level: payload.level as string | undefined,
      });
      patchChain = chain;
      break;
    }
    case 'patch_applied':
      patchChain = patchChain.map((entry) =>
        entry.patchId === payload.patch_id
          ? { ...entry, status: 'applied' as const, appliedAt: at }
          : entry,
      );
      break;
    case 'patch_reverted':
      patchChain = patchChain.map((entry) =>
        entry.patchId === payload.patch_id
          ? { ...entry, status: 'reverted' as const, revertedAt: at, revertReason: String(payload.reason ?? '') }
          : entry,
      );
      break;
    case 'vetting_result': {
      const tool = String(payload.tool ?? payload.target ?? '');
      const rawVerdict = String(payload.verdict ?? '');
      const verdict = rawVerdict === 'fail' || rawVerdict === 'review' ? rawVerdict : 'pass';
      const reason = payload.reason as string | undefined;
      messages = [...messages, { kind: 'vetting', tool, verdict, reason, id: nextId(), stepId: stepId || undefined, roundId }];
      const traces = [...sourceTraces];
      traces.push({
        id: nextId(),
        sourceType: 'evidence',
        title: `vetting：${tool}`,
        detail: verdict === 'pass' ? '静态钩子核对通过' : `拦截：${reason ?? ''}`,
        createdAt: at,
      });
      sourceTraces = traces.slice(-SOURCE_TRACES_MAX);
      break;
    }
    case 'assembly_started':
      upsertStep({ stepId: 'assembly', type: 'assembly', label: '组装', status: 'running' }, (s) => ({ ...s, status: 'running' as const }));
      break;
    case 'assembly_done': {
      // 组装阶段折叠为一条轨迹步骤（耗时 = payload.ts 墙钟 − 步骤起点）
      const ts = typeof payload.ts === 'number' ? payload.ts * 1000 : undefined;
      upsertStep({ stepId: 'assembly', type: 'assembly', label: '组装', status: 'done' }, (s) => ({
        ...s,
        status: 'done' as const,
        ...(ts != null && s.startedAt ? { elapsedMs: Math.max(0, ts - s.startedAt) } : {}),
      }));
      break;
    }
    case 'execution_started':
      // 真正执行开始：组装阶段若尚在 running（未收尾）则定型为 done；
      // 无组装步骤（未启用组装）不凭空建卡
      roundSteps = roundSteps.map((s) =>
        s.stepId === 'assembly' && s.status === 'running' ? { ...s, status: 'done' as const } : s,
      );
      break;
    case 'assembly_candidate':
    case 'junction_verdict':
    case 'junction_verdict_audit':
    case 'assembly_audit':
    case 'fingerprint_replace_audit':
    case 'policy_edge_review_audit':
    case 'recommended_prior_promotion':
    case 'node_start':
    case 'evolution_variant': {
      if (type === 'node_start') {
        upsertStep(
          { stepId, type: 'node', label: String(payload.label ?? payload.name ?? '节点'), status: 'running' },
          (s) => ({ ...s, status: 'running' as const }),
        );
      }
      // 审计/观察事件消费：生产模式也落位 sourceTraces（证据溯源），
      // 避免后端产出、前端静默丢弃；dev 模式额外折叠进消息流
      const auditTitle =
        typeof payload.summary === 'string' && payload.summary
          ? payload.summary
          : (typeof payload.tool === 'string' ? `工具：${payload.tool}` : event.type);
      const traces = [...sourceTraces];
      traces.push({
        id: nextId(),
        sourceType: 'evidence',
        title: auditTitle,
        detail: typeof payload.reason === 'string' ? payload.reason : '',
        createdAt: at,
      });
      sourceTraces = traces.slice(-SOURCE_TRACES_MAX);
      if (getUiStateStore().get<boolean>(DEV_MODE_KEY)) {
        const keys = typeof payload === 'object' && payload ? Object.keys(payload).slice(0, 8) : [];
        const digest = keys.length ? ` · ${keys.join(', ')}` : '';
        messages = [...messages, { kind: 'unknown', token: `观察事件：${event.type}${digest}`, id: nextId(), stepId: stepId || undefined, roundId }];
      }
      break;
    }
    case 'turn_started':
      // 回合入口：与 user_message 同语义重置回合步骤序列（时间线起点）
      roundSteps = [{ stepId: 'user', type: 'user', label: '用户', status: 'done', startedAt: at }];
      break;
    case 'attachment': {
      // 附件事件落位消息流（引擎 Attachment 契约形态；负载为协商形态）
      const name = String(payload.name ?? payload.url ?? '附件');
      messages = [...messages, { kind: 'attachment', content: name, id: nextId(), stepId: stepId || undefined, roundId }];
      break;
    }
    case 'node_end':
      upsertStep(
        { stepId, type: 'node', label: String(payload.label ?? payload.name ?? '节点'), status: 'done' },
        (s) => ({ ...s, status: 'done' as const }),
      );
      break;
    case 'node_fail':
      upsertStep(
        { stepId, type: 'node', label: String(payload.label ?? payload.name ?? '节点'), status: 'failed' },
        (s) => ({ ...s, status: 'failed' as const }),
      );
      break;
    case 'tuning_update': {
      // seed schema: metric(required)/delta(number)/snapshot(boolean)；
      // detail 通道不在 schema 中（历史读取已失效），改按 metric+delta 组合
      const metric = String(payload.metric ?? '');
      const delta = typeof payload.delta === 'number' ? payload.delta : undefined;
      const detail = [
        metric ? `指标：${metric}` : '',
        delta != null ? `Δ${delta >= 0 ? '+' : ''}${delta}` : '',
      ].filter(Boolean).join(' · ');
      const traces = [...sourceTraces];
      traces.push({
        id: nextId(),
        sourceType: 'evidence',
        title: metric ? `调优：${metric}` : '调优应用',
        detail: detail || String(payload.detail ?? ''),
        createdAt: at,
      });
      sourceTraces = traces.slice(-SOURCE_TRACES_MAX);
      break;
    }
    case 'end':
      // 回合结束信号：不建卡（消息流/指标已承载），仅推进状态
      break;
    default: {
      // 未落位的事件类型：原始负载属诊断信息，仅开发者模式建折叠兜底卡；
      // 普通模式跳过（消息流不泄露引擎内部事件）。
      if (getUiStateStore().get<boolean>(DEV_MODE_KEY)) {
        // dev 模式也只展示事件名 + 载荷键摘要，不把引擎内部事件结构
        // 原样 JSON 进用户视图（内部字段/敏感载荷不外泄）。
        const keys = typeof payload === 'object' && payload ? Object.keys(payload).slice(0, 8) : [];
        const digest = keys.length ? ` · ${keys.join(', ')}` : '';
        messages = [...messages, { kind: 'unknown', token: `新事件：${event.type}${digest}`, id: nextId(), stepId: stepId || undefined, roundId }];
      }
      break;
    }
  }

  const nextBucket: ThreadBucket = {
    roundId: nextRoundId,
    roundSteps,
    simulations,
    incubation,
    sourceTraces,
    patchChain,
  };
  hub.setState({
    ...next,
    messages: isActive ? messages : state.messages,
    perThread: { ...state.perThread, [targetThread]: nextBucket },
    roundId: isActive ? state.roundId ?? nextRoundId : state.roundId,
    taskState,
    // 当前会话桶 → 全局镜像（既有组件零改动读快照即得当前会话数据）
    ...(isActive ? { roundSteps, simulations, incubation, sourceTraces, patchChain } : {}),
  });
}

/**
 * 会话驱动：从事件源（SSE/夹具脚本）逐条 ingest。
 * 批次指标在事件流结束后统一输出（避免逐事件噪音）。
 *
 * streaming 超时兜底：回合异常终止未发 end 事件时，若 STREAMING_TIMEOUT_MS
 * 内无 reply_token 更新，自动把残留 streaming 消息定型为 text/assistant
 * （保留已收内容、停止闪烁）。定时器随 ingest 调用重置，end 事件清除。
 */
export function createIngester(hub: ChannelHub): (event: HubEvent) => void {
  const counter = new BatchCounter('session', '事件流批次');
  let streamingTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStreamingTimer = () => {
    if (streamingTimer) {
      clearTimeout(streamingTimer);
      streamingTimer = null;
    }
  };

  const resetStreamingTimer = () => {
    clearStreamingTimer();
    streamingTimer = setTimeout(() => {
      streamingTimer = null;
      commitStreaming(hub);
    }, STREAMING_TIMEOUT_MS);
  };

  return (event) => {
    counter.add(event.type, event.type === 'reply_token' ? String(event.payload.token ?? '').length : 0);
    if (event.type === 'reply_token') {
      resetStreamingTimer();
    }
    if (event.type === 'end') {
      clearStreamingTimer();
      // 事件流结束：批次指标统一输出（承诺落空修复）
      counter.flush(true);
    }
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
export function commitStreaming(hub: ChannelHub): void {
  const snapshot = hub.getSnapshot();
  if (!snapshot.messages.some((m) => m.kind === 'streaming')) return;
  const messages = snapshot.messages.map((m) =>
    m.kind === 'streaming' ? { ...m, kind: 'text' as const, role: 'assistant' as const } : m,
  );
  hub.setState({ ...snapshot, messages, streaming: false });
}

/**
 * 附件资产 → 引擎 Attachment 契约形态的出站序列化。
 *
 * 对齐引擎 Attachment（kind + url 必备）：缺 url/path 引用的资产不入载荷
 * （引擎要求引用存在，否则序列化会被拒）；name/mime/alt 作展示与诊断补充。
 */
export function toEngineAttachments(assets: AttachmentAsset[]): OutboundAttachment[] {
  const out: OutboundAttachment[] = [];
  for (const asset of assets) {
    const url = asset.url;
    if (!url) continue;
    out.push({ kind: asset.kind, url, name: asset.name, mime: asset.mime || undefined, alt: asset.name });
  }
  return out;
}

/**
 * 真实回合提交（宿主驱动侧）：只落用户气泡 + 开启流式态，回复由
 * 回合事件流（round_event）增量渲染；返回 roundId 供宿主下发 round_send。
 */
export function submitUserRound(
  hub: ChannelHub,
  text: string,
  attachments?: AttachmentAsset[],
  roundId = `round-${Date.now()}`,
): string {
  const snapshot = hub.getSnapshot();
  const payload = toEngineAttachments(attachments ?? []);
  const userMsg: InkMessage = {
    kind: 'text',
    role: 'user',
    content: text,
    id: nextId(),
    roundId,
    ...(payload.length > 0 ? { attachments: payload } : {}),
  };
  hub.setState({ ...snapshot, messages: [...snapshot.messages, userMsg], roundId, streaming: true });
  return roundId;
}

export function setGear(hub: ChannelHub, activeGear: Parameters<ChannelHub['setState']>[0]['activeGear']): void {
  hub.setState({ activeGear });
}

export function setModeTier(hub: ChannelHub, modeTier: Parameters<ChannelHub['setState']>[0]['modeTier']): void {
  hub.setState({ modeTier });
}

/** 附件资产（经媒体策略分发后的形态：图片/视频/文档三类可落位）。 */
export interface AttachmentAsset {
  kind: 'image' | 'video' | 'document';
  name: string;
  mime: string;
  size: number;
  url?: string;
  width?: number;
  height?: number;
}

/**
 * 附件落位：文件选择入口分发出的媒体资产 → 消息流条目（独立条目，不拼接）。
 * 资产已经媒体策略校验（类型/大小/路径），此处只负责落位。
 */
export function submitAttachments(hub: ChannelHub, assets: AttachmentAsset[], at = Date.now()): void {
  if (assets.length === 0) return;
  const snapshot = hub.getSnapshot();
  const roundId = snapshot.roundId ?? `round-${at}`;
  const created: InkMessage[] = assets.map((asset) => {
    const base = { id: nextId(), roundId };
    if (asset.kind === 'image') {
      return { ...base, kind: 'image', url: asset.url ?? asset.name, mime: asset.mime, width: asset.width, height: asset.height };
    }
    if (asset.kind === 'video') {
      return { ...base, kind: 'video', url: asset.url ?? asset.name, mime: asset.mime, size: asset.size };
    }
    return { ...base, kind: 'document', name: asset.name, size: asset.size, url: asset.url };
  });
  hub.setState({ ...snapshot, messages: [...snapshot.messages, ...created] });
}
