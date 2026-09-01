/**
 * 通道中枢（ChannelHub）：绑定协议的前端落位——单一事实源 + 细粒度订阅。
 *
 * 绑定协议：{"bind":{"channel":"...","path":"..."}}
 * - state.* 通道：会话状态快照（messages/round_steps 等），订阅 = 状态变更；
 * - events.* 通道：事件流（按事件类型细粒度订阅，互不干扰）；
 * - inspect_* 通道：六元工具快照（演化时间线/孵化面板数据源）。
 *
 * 白名单判定不在这里（renderer/channelWhitelist 负责），本类只做
 * 通道注册与分发；未知通道订阅直接拒绝（fail-closed）。
 *
 * 框架无关：getSnapshot/subscribe 契约 + 不可变快照，React 侧经
 * useSyncExternalStore 消费（见 renderer/stateChannel）。
 */

import type { EventTypeName } from './eventTypes';
import type { InspectChannelName, InspectSnapshot } from './inspectTypes';
import type { InkMessage, RoundStep, SimulationBranch, IncubationEntry, SourceTraceEntry, PatchChainEntry, GearTier, ModeTier } from './types';
import type { TaskState } from './taskState';
import { emptyTaskState } from './taskState';

/** 会话状态快照（state.* 通道的根对象）。 */
export interface SessionSnapshot {
  activeSessionId: string;
  messages: InkMessage[];
  roundSteps: RoundStep[];
  roundId: string | null;
  streaming: boolean;
  activeGear: GearTier;
  modeTier: ModeTier;
  pendingReview: Record<string, unknown> | null;
  simulations: SimulationBranch[];
  incubation: IncubationEntry[];
  sourceTraces: SourceTraceEntry[];
  patchChain: PatchChainEntry[];
  eventMetrics: { total: number; tokens: number; lastAt: number };
  /** 任务级执行状态（task_state 子通道根对象）。 */
  taskState: TaskState;
  /** 按 thread_id 分桶的回合状态（演化/推演/实例数据随会话窗口区分）。 */
  perThread: Record<string, ThreadBucket>;
}

/** 单会话窗口的回合状态桶（与 messages 分储：消息随 sessionStore，桶随 hub）。 */
export interface ThreadBucket {
  roundId: string | null;
  roundSteps: RoundStep[];
  simulations: SimulationBranch[];
  incubation: IncubationEntry[];
  sourceTraces: SourceTraceEntry[];
  patchChain: PatchChainEntry[];
  /** 桶最后活跃时间（事件落位即刷新）；跨会话清理 TTL 依据。 */
  lastSeenAt: number;
}

export function emptyThreadBucket(): ThreadBucket {
  return {
    roundId: null,
    roundSteps: [],
    simulations: [],
    incubation: [],
    sourceTraces: [],
    patchChain: [],
    lastSeenAt: Date.now(),
  };
}

export function emptySessionSnapshot(): SessionSnapshot {
  return {
    activeSessionId: '',
    messages: [],
    roundSteps: [],
    roundId: null,
    streaming: false,
    activeGear: 'main',
    modeTier: 'default',
    pendingReview: null,
    simulations: [],
    incubation: [],
    sourceTraces: [],
    patchChain: [],
    eventMetrics: { total: 0, tokens: 0, lastAt: 0 },
    taskState: emptyTaskState(),
    perThread: {},
  };
}

/** 事件负载（events.* 通道的投递值）。 */
export interface HubEvent {
  type: EventTypeName;
  payload: Record<string, unknown>;
  at: number;
}

type Listener = () => void;

/** 框架无关的状态与事件中枢。 */
export class ChannelHub {
  private state: SessionSnapshot = emptySessionSnapshot();
  private stateListeners = new Set<Listener>();

  private eventListeners = new Map<EventTypeName, Set<(event: HubEvent) => void>>();
  private lastEvents = new Map<EventTypeName, HubEvent>();

  private inspect: Record<InspectChannelName, InspectSnapshot>;
  private inspectListeners = new Map<InspectChannelName, Set<Listener>>();

  constructor(inspectInitial?: Partial<Record<InspectChannelName, InspectSnapshot>>) {
    this.inspect = {
      inspect_graph: { version: 0, nodes: [], edges: [], patchChain: [] },
      inspect_rules: { version: 0, rules: [] },
      inspect_knowledge: { version: 0, entries: [] },
      inspect_ui: { version: 0, componentWhitelist: [], bindChannelWhitelist: [], themeTokenWhitelist: [] },
      inspect_tools: { version: 0, tools: [] },
      inspect_entities: { version: 0, entities: [], count: 0 },
      ...(inspectInitial ?? {}),
    };
  }

  // ===== 会话状态（state.*）=====

  getSnapshot(): SessionSnapshot {
    return this.state;
  }

  subscribeState(listener: Listener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** 状态写入（会话驱动侧调用；整体替换保证不可变快照语义）。 */
  setState(patch: Partial<SessionSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener();
  }

  // ===== 事件流（events.*）=====

  /** 按事件类型细粒度订阅：只接收该类型的事件，其余事件不触发。 */
  onEvent(type: EventTypeName, listener: (event: HubEvent) => void): () => void {
    let set = this.eventListeners.get(type);
    if (!set) {
      set = new Set();
      this.eventListeners.set(type, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  /** 事件写入（会话驱动侧调用：事件落位 + 指标聚合）。 */
  dispatch(event: HubEvent): void {
    const snapshot = this.state;
    const eventMetrics = {
      total: snapshot.eventMetrics.total + 1,
      tokens:
        event.type === 'reply_token'
          ? snapshot.eventMetrics.tokens + String(event.payload.token ?? '').length
          : snapshot.eventMetrics.tokens,
      lastAt: event.at,
    };
    this.state = { ...snapshot, eventMetrics };
    this.lastEvents.set(event.type, event);
    for (const listener of this.stateListeners) listener();
    const set = this.eventListeners.get(event.type);
    if (set) {
      for (const listener of set) listener(event);
    }
  }

  /** 最近一次事件（useSyncExternalStore 快照语义：事件通道订阅的取值面）。 */
  getLastEvent(type: EventTypeName): HubEvent | undefined {
    return this.lastEvents.get(type);
  }

  // ===== inspect_* 六元快照 =====

  getInspect(channel: InspectChannelName): InspectSnapshot {
    return this.inspect[channel];
  }

  subscribeInspect(channel: InspectChannelName, listener: Listener): () => void {
    let set = this.inspectListeners.get(channel);
    if (!set) {
      set = new Set();
      this.inspectListeners.set(channel, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  setInspect(channel: InspectChannelName, snapshot: InspectSnapshot): void {
    this.inspect = { ...this.inspect, [channel]: snapshot };
    const set = this.inspectListeners.get(channel);
    if (set) {
      for (const listener of set) listener();
    }
  }
}
