/**
 * 状态机原语与 append-only 转换日志（状态机通用底座，state_machine.py 移植）。
 *
 * 心智模型与引擎的补丁链一致：转换 = 补丁（append-only），当前状态 = 最后
 * 应用结果。状态机不持有可变状态字段，而是持有一条不可回写的转换日志——
 * 因此天然支持回溯（这个状态何时变成这样）、回滚（截断日志重推）与分支
 * （复制日志前缀）。
 *
 * 三个组件各司其职：
 * - StateMachine：声明式规则（合法状态集 + 终态 + 可选转换白名单），纯判定、
 *   无状态、可共享为模块级单例；
 * - StateTransition：一条转换记录（不可变，可序列化落库）；
 * - TransitionLog：append-only 日志容器，当前状态由日志推导。
 *
 * 领域中立：状态名、终态、触发方（actor）取值均由使用方声明，引擎不内置
 * 任何业务状态语义（具体状态定义由使用方领域包声明）。
 *
 * 副作用边界：Python 的 time.time() 取点（at 缺省）在 TS 侧为时间注入 seam
 * TimeSource（与 ledger 的 now 同口径）——宿主不注入时按确定性默认 0 落盘，
 * 保证纯函数可复现；logging 仅作拒绝留痕的观察面，不影响判定语义，纯核心
 * 省略。
 */

import { isRecord, type JsonRecord } from '../json.js';

/** 时间源 seam（等价 Python time.time）；宿主注入，缺省取确定性默认。 */
export type TimeSource = () => number;

/** 初始写入（实体首次获得状态）的 from_state 约定值：无前态。 */
export const INITIAL_STATE: null = null;

/** 转换白名单声明形态：前态 -> 允许的后态清单。 */
export type AllowedMap = Readonly<Record<string, readonly string[]>>;

/** StateMachine 构造选项（对应 Python 关键字参数）。 */
export interface StateMachineOptions {
  terminal_states?: readonly string[];
  allowed?: AllowedMap | null;
  name?: string;
}

/** StateTransition 构造入参（to_state 必填，其余缺省走默认值）。 */
export interface StateTransitionInit {
  to_state: string;
  from_state?: string | null;
  actor?: string;
  note?: string | null;
  at?: number;
  meta?: JsonRecord;
  now?: TimeSource;
}

/** StateTransition.from_dict 的注入面（at 缺省时的时间源）。 */
export interface FromDictOptions {
  now?: TimeSource;
}

/** TransitionLog 构造选项（对应 Python 关键字参数）。 */
export interface TransitionLogOptions {
  initial_state?: string | null;
  entries?: readonly StateTransition[];
}

/** append 的逐条注入面（触发方/说明/元数据/时间戳与时间源）。 */
export interface AppendOptions {
  actor?: string;
  note?: string | null;
  at?: number;
  meta?: JsonRecord;
  now?: TimeSource;
}

/** 解析 at：缺失/假值走时间源默认（对齐 Python `or` 口径），数值格式非法即报错。 */
function resolveAt(raw: unknown, now: TimeSource | undefined): number {
  if (!raw) return now ? now() : 0;
  const num = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isFinite(num)) {
    throw new Error(`at 字段无法解析为数值: ${String(raw)}`);
  }
  return num;
}

/**
 * 一条状态转换记录（append-only 日志条目，不可变）。
 *
 * to_state：转换后状态；from_state：转换前状态（null = 初始写入）；
 * actor：触发方（业务自定义取值）；note：转换说明（可读留痕）；at：发生
 * 时间戳（epoch 秒）；meta：业务元数据（关联目标/实体等，落库随记录序列化）。
 * 构造即冻结实例——字段只读在运行时同样成立（镜像 Python frozen dataclass
 * 的赋值即抛错），meta 一律防御性拷贝。
 */
export class StateTransition {
  readonly to_state: string;
  readonly from_state: string | null;
  readonly actor: string;
  readonly note: string | null;
  readonly at: number;
  readonly meta: JsonRecord;

  constructor(init: StateTransitionInit) {
    this.to_state = init.to_state;
    this.from_state = init.from_state ?? INITIAL_STATE;
    this.actor = init.actor ?? 'system';
    this.note = init.note ?? null;
    this.at = init.at ?? (init.now ? init.now() : 0);
    this.meta = { ...(init.meta ?? {}) };
    Object.freeze(this);
  }

  to_dict(): JsonRecord {
    return {
      to_state: this.to_state,
      from_state: this.from_state,
      actor: this.actor,
      note: this.note,
      at: this.at,
      meta: { ...this.meta },
    };
  }

  /** 从存储记录还原（字段缺失走默认值，兼容 schema 增量演进）。 */
  static from_dict(data: unknown, options: FromDictOptions = {}): StateTransition {
    if (!isRecord(data)) {
      throw new TypeError('状态转换记录须为字典');
    }
    const toRaw = data['to_state'];
    if (toRaw === undefined || toRaw === null) {
      throw new Error('状态转换记录缺 to_state 字段');
    }
    const fromRaw = data['from_state'];
    const noteRaw = data['note'];
    const actorRaw = data['actor'];
    const metaRaw = data['meta'];
    return new StateTransition({
      to_state: String(toRaw),
      from_state: fromRaw === undefined || fromRaw === null ? null : String(fromRaw),
      actor: actorRaw ? String(actorRaw) : 'system',
      note: noteRaw === undefined || noteRaw === null ? null : String(noteRaw),
      at: resolveAt(data['at'], options.now),
      meta: isRecord(metaRaw) ? metaRaw : undefined,
    });
  }
}

/**
 * 声明式状态机规则（纯判定，无状态，线程安全可作模块级单例）。
 *
 * 规则按以下顺序判定一次转换是否非法：
 * 1. 目标状态不在 states 中 → 非法（防拼写错误/越界状态写入）；
 * 2. 前态属于 terminal_states → 非法（终态单向，不得复活）；
 * 3. 声明了 allowed 白名单且该转换不在白名单内 → 非法。
 *
 * 未声明 allowed 时，除终态约束外的任意转换都合法——多数领域只需「终态
 * 单向」这一条规则，无需枚举全部转换对（避免声明爆炸）。终态或白名单引用
 * 了 states 之外的状态在构造期即报错（配置错误尽早暴露，而非运行期静默
 * 误判）。
 */
export class StateMachine {
  readonly name: string;
  private readonly stateSet: ReadonlySet<string>;
  private readonly terminalSet: ReadonlySet<string>;
  private readonly allowedMap: ReadonlyMap<string, ReadonlySet<string>> | null;

  constructor(states: Iterable<string>, options: StateMachineOptions = {}) {
    this.name = options.name ?? 'state_machine';
    this.stateSet = new Set<string>(states);
    this.terminalSet = new Set<string>(options.terminal_states ?? []);
    const unknownTerminal = [...this.terminalSet]
      .filter((s) => !this.stateSet.has(s))
      .sort();
    if (unknownTerminal.length > 0) {
      throw new Error(
        `${this.name}: 终态 ${JSON.stringify(unknownTerminal)} 不在合法状态集内`,
      );
    }
    const allowed = options.allowed;
    if (allowed !== undefined && allowed !== null) {
      const map = new Map<string, ReadonlySet<string>>();
      const referenced = new Set<string>();
      for (const [src, dsts] of Object.entries(allowed)) {
        map.set(src, new Set<string>(dsts));
        referenced.add(src);
        for (const dst of dsts) referenced.add(dst);
      }
      const unknownAllowed = [...referenced]
        .filter((s) => !this.stateSet.has(s))
        .sort();
      if (unknownAllowed.length > 0) {
        throw new Error(
          `${this.name}: 转换白名单引用了非法状态 ${JSON.stringify(unknownAllowed)}`,
        );
      }
      this.allowedMap = map;
    } else {
      this.allowedMap = null;
    }
  }

  /** 合法状态集（只读视图）。 */
  get states(): ReadonlySet<string> {
    return this.stateSet;
  }

  /** 终态集（进入后不得转出；只读视图）。 */
  get terminal_states(): ReadonlySet<string> {
    return this.terminalSet;
  }

  /** 状态是否为合法枚举值（None 不是合法状态，仅作初始前态占位）。 */
  is_valid_state(state: string | null): boolean {
    return state !== null && this.stateSet.has(state);
  }

  /** 状态是否为终态（进入后不得转出）。 */
  is_terminal(state: string | null): boolean {
    return state !== null && this.terminalSet.has(state);
  }

  /** 判断一次转换是否非法（纯函数，可直接用于写时预检）。 */
  is_illegal_transition(from_state: string | null, to_state: string): boolean {
    if (!this.is_valid_state(to_state)) return true;
    if (this.is_terminal(from_state)) return true;
    if (this.allowedMap !== null && from_state !== INITIAL_STATE) {
      const dsts = this.allowedMap.get(from_state);
      return dsts === undefined || !dsts.has(to_state);
    }
    return false;
  }

  /** 按本规则新建一条转换日志（便捷工厂）。 */
  log(options: TransitionLogOptions = {}): TransitionLog {
    return new TransitionLog(this, options);
  }
}

/**
 * append-only 转换日志：当前状态由日志推导，不单独存可变状态字段。
 *
 * append 拦截三类写入：无变化（目标 = 当前状态）、目标状态非法、非法转换
 * （经 StateMachine.is_illegal_transition 判定——终态复活与白名单外转换），
 * 拦截即拒绝写入并返回 null、不落日志；终态单向与白名单约束由此内置强制，
 * 调用方无需自行预检。
 */
export class TransitionLog {
  private readonly machineRef: StateMachine;
  private readonly initial: string | null;
  private readonly entryList: StateTransition[];

  constructor(machine: StateMachine, options: TransitionLogOptions = {}) {
    this.machineRef = machine;
    this.initial = options.initial_state ?? INITIAL_STATE;
    this.entryList = [...(options.entries ?? [])];
  }

  get machine(): StateMachine {
    return this.machineRef;
  }

  /** 当前状态 = 最后一条转换的目标状态（空日志 = 初始状态）。 */
  get current_state(): string | null {
    const last = this.entryList[this.entryList.length - 1];
    return last === undefined ? this.initial : last.to_state;
  }

  /** 完整转换链（正序：最早 → 最新），供回溯查询（返回副本）。 */
  history(): StateTransition[] {
    return [...this.entryList];
  }

  /** 已落条目数（对应 Python len(log)）。 */
  get length(): number {
    return this.entryList.length;
  }

  /**
   * 追加一次转换。
   *
   * 拦截规则强制：无实际变化、目标状态非法、非法转换（终态复活 / 白名单外）
   * 一律拒绝写入——返回 null 且不写日志（Python 拒绝时的 warning 留痕属
   * 观察面副作用，纯核心省略）。meta 防御性拷贝，调用方事后改动不影响已落
   * 条目。
   *
   * @returns 落日志的转换记录；被拦截（无变化/目标非法/非法转换）时为 null。
   */
  append(to_state: string, options: AppendOptions = {}): StateTransition | null {
    const fromState = this.current_state;
    if (to_state === fromState) return null;
    if (!this.machineRef.is_valid_state(to_state)) return null;
    if (this.machineRef.is_illegal_transition(fromState, to_state)) return null;
    const entry = new StateTransition({
      to_state,
      from_state: fromState,
      actor: options.actor ?? 'system',
      note: options.note ?? null,
      at: options.at ?? (options.now ? options.now() : 0),
      meta: options.meta,
    });
    this.entryList.push(entry);
    return entry;
  }

  /**
   * 回滚最近 N 次转换（截断日志，当前状态随之重推）。
   *
   * steps <= 0 为空操作，超过日志长度则回到初始状态。
   *
   * @returns 回滚后的当前状态。
   */
  rollback(steps = 1): string | null {
    if (steps > 0) {
      const keep = Math.max(0, this.entryList.length - steps);
      this.entryList.length = keep;
    }
    return this.current_state;
  }
}
