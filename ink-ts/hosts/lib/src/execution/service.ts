/**
 * 宿主执行装配（HostExecutionService）：把引擎 ExecutionRuntime（作用域/通道
 * 执行运行时）接进宿主命令面与组织类工具的唯一装配点。
 *
 * 宿主只装配不复制：运行时循环/通道闸门/归并契约全在 engine
 * core/execution_runtime，本模块做的事 = 注入依赖（作用域装载读实体目录、
 * 默认通道目录、作用域轮次引擎装载执行器、审批姿态 → 通道审批 seam）+
 * 调用（runExecution = execution 主线入口；convene = 多协作者召集协议）。
 * 每 boot 一实例，随 restore/reboot 整体替换（createHost.applyParts 活引用
 * 切换），审批策略经闭包活读 InkHost.interrupt_policy()。
 *
 * 通道审批 seam 口径：auto 姿态/能力直过名单 = 'auto' 放行；review 姿态下
 * 本 seam 无法挂卡（执行循环非引擎回合，无 checkpoint 挂起通道），fail-closed
 * 阻断并在结果里可见原因——人审弹卡由组织类工具入口的统一流水线承担
 * （collab_request review 档 = 既有审批卡流程），通道档只作二次闸门。
 */

import {
  ChannelDirectory,
  ExecutionRuntime,
  ORG_ARCHIVE_SCHEMA_VERSION,
  OrgArchive,
  default_channel_seeds,
  default_scope_priors,
  normalizeApprovalPose,
} from '@ink-ts/engine';
import type {
  ExecutionRequest,
  ExecutionResult,
  LoadedScope,
  RunEvent,
  ScopeLoader,
  ScopePriorPattern,
  ScopeTurnRunner,
  TransitionApprovalSeam,
} from '@ink-ts/engine';
import type { GuardrailConfig } from '@ink-ts/engine';
import type { InterruptPolicy } from '@ink-ts/engine';
import type { Storage } from '@ink-ts/engine';

/** 组织档案持久化集合/键（走引擎 Storage 结构化记录普通通道，非演化资产）。 */
const ORG_ARCHIVE_COLLECTION = 'org.archive';
const ORG_ARCHIVE_KEY = 'snapshot';

/** 执行装配构造项（boot 注入；测试注入 fake turn 以隔离引擎装载）。 */
export interface HostExecutionServiceInit {
  /** 目录作用域装载（宿主实体目录；未注册/已下架 = null fail-closed）。 */
  loadScope: ScopeLoader;
  /** 通道目录（缺省 = 出厂典型通道素材；每次装配新鲜实例避免跨会话污染）。 */
  channels?: ChannelDirectory | null;
  /** 单轮作用域加工注入面（非空 = 跳过引擎装载执行器；测试 seam）。 */
  turnOverride?: ScopeTurnRunner | null;
  /** 引擎装载执行器工厂（turnOverride 缺省时每次执行现装配）。 */
  makeTurn?: (() => Promise<ScopeTurnRunner> | ScopeTurnRunner) | null;
  /** 审批策略活读面（InkHost interrupt_policy；null = 全量 fail-closed）。 */
  approvalPolicy?: (() => InterruptPolicy | null) | null;
  /** 先验路线集（缺省 = 出厂默认先验素材）。 */
  priors?: readonly ScopePriorPattern[] | null;
  /** boot 基线系统提示词（作用域 persona 叠加在其后）。 */
  bootSystemPrompt?: string;
  /** 护栏覆写（缺省 = 引擎出厂默认档）。 */
  guardrails?: GuardrailConfig | null;
  /** 时钟（事件时间戳；缺省 = 确定性 0）。 */
  nowMs?: () => number;
  /** 存储访问器（组织档案快照持久化用；null = 不落盘，纯内存档案）。 */
  storage?: (() => Storage | null) | null;
  /** 作用域模型 context_window 解析（按 model 引用查用户 model 列表档案；null = 无档案/未指派，回落引擎 200k 兜底）。 */
  resolveScopeContextWindow?: ((model: Record<string, string> | null) => number | null) | null;
  /** 执行请求拦截（测试 seam；非空 = 每次 runExecution 前回调请求对象）。 */
  onRunExecution?: ((request: ExecutionRequest) => void) | null;
}

/** 单次执行入口选项。 */
export interface RunExecutionOptions {
  /** 审批姿态（auto/review/deny；缺省 review 现行为）。 */
  pose?: string | null;
  /** 护栏覆写（召集 budget 折入 max_cost；非空逐字段覆盖装配默认档）。 */
  guardrails?: GuardrailConfig | null;
  /** 事件带 sink（执行树事件透出；与返回值 events 并行收集）。 */
  onEvent?: (event: RunEvent) => void;
}

/** 通道审批 seam 构造（审批姿态 × 宿主审批策略 → accept/auto/reject）。 */
export function transitionApprovalSeam(
  policy: InterruptPolicy | null,
  pose: string | null | undefined,
  keyTool: string,
): TransitionApprovalSeam {
  const normalized = normalizeApprovalPose(pose);
  return async (request) => {
    // 与引擎 approve_before_execute 同序：策略显式预授权不被 pose 收回
    const key = `channel:${request.channel_id}`;
    const action: Record<string, unknown> = {
      tool: keyTool,
      ...request.action,
    };
    if (policy !== null && !policy.should_approve(key, action)) return 'auto';
    if (normalized === 'deny') return 'reject';
    if (normalized === 'auto') return 'auto';
    // review 态：转场处无挂卡通道（执行循环非引擎回合），fail-closed 阻断，
    // 原因随 run 结果可见——人审卡由 collab_request 工具入口流水线承担。
    return 'reject';
  };
}

/** 宿主执行装配（runExecution 主线 + convene 召集协议共用一套依赖注入）。 */
export class HostExecutionService {
  private readonly init: HostExecutionServiceInit;
  readonly channels: ChannelDirectory;
  readonly priors: readonly ScopePriorPattern[];
  /** 组织档案（轨迹 ingest 内存态；settle 后落盘快照）。 */
  orgArchive: OrgArchive;
  /** 最近一次执行的 run_id 游标（convene 子 run 命名空间；进程内单调）。 */
  private sequence = 0;
  /** 档案快照加载/持久化 promise（避免并发 persist 覆盖）。 */
  private archiveFlush: Promise<void> = Promise.resolve();

  constructor(init: HostExecutionServiceInit) {
    this.init = init;
    if (init.channels !== undefined && init.channels !== null) {
      this.channels = init.channels;
    } else {
      const dir = new ChannelDirectory();
      for (const seed of default_channel_seeds()) dir.register(seed);
      this.channels = dir;
    }
    this.priors = init.priors ?? default_scope_priors();
    this.orgArchive = new OrgArchive();
    if (init.storage !== undefined && init.storage !== null) {
      this.archiveFlush = this.loadArchiveSnapshot().catch(() => {});
    }
  }

  /** 目录作用域是否在装载面命中（未注册/已下架 = false）。 */
  hasScope(scope_id: string): boolean {
    return this.init.loadScope(scope_id) !== null;
  }

  /** 作用域装载（null = 不可装载，调用方 fail-closed 拒绝）。 */
  loadScope(scope_id: string): LoadedScope | null {
    return this.init.loadScope(scope_id);
  }

  /** 作用域模型的 context_window（按引用查用户 model 列表；无档案/未指派 = null）。 */
  resolveScopeContextWindow(model: Record<string, string> | null): number | null {
    const resolver = this.init.resolveScopeContextWindow;
    if (resolver === undefined || resolver === null) return null;
    return resolver(model);
  }

  /** 下一次执行的 run 序号（宿主控制命名 run_id 用）。 */
  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /** 转场审批 seam（按姿态 + 活读审批策略构造；每次执行现取）。 */
  approvalSeam(pose: string | null | undefined, keyTool: string): TransitionApprovalSeam {
    const policyFn = this.init.approvalPolicy;
    const policy =
      policyFn !== undefined && policyFn !== null ? policyFn() : null;
    return transitionApprovalSeam(policy, pose, keyTool);
  }

  /** 单轮作用域加工执行器（注入面优先；缺省引擎装载现装配）。 */
  async turnRunner(): Promise<ScopeTurnRunner> {
    if (this.init.turnOverride !== undefined && this.init.turnOverride !== null) {
      return this.init.turnOverride;
    }
    if (this.init.makeTurn === undefined || this.init.makeTurn === null) {
      throw new Error('作用域轮次执行器未装配（turnOverride/makeTurn 至少给一）');
    }
    return this.init.makeTurn();
  }

  /** 从 storage 加载组织档案持久快照（boot 时调用；无快照 = 空档案继续）。 */
  async loadArchiveSnapshot(): Promise<void> {
    const storageGetter = this.init.storage;
    if (storageGetter === undefined || storageGetter === null) return;
    const storage = storageGetter();
    if (storage === null) return;
    try {
      const record = await storage.get_record(ORG_ARCHIVE_COLLECTION, ORG_ARCHIVE_KEY);
      if (record !== null && typeof record === 'object') {
        this.orgArchive = OrgArchive.from_dict(record);
      }
    } catch {
      // 快照损坏或版本不兼容：保留空档案，不击穿 boot
    }
  }

  /** 将组织档案当前态持久化为快照（settle 后调用；失败不击穿执行结果）。 */
  async persistArchiveSnapshot(): Promise<void> {
    const storageGetter = this.init.storage;
    if (storageGetter === undefined || storageGetter === null) return;
    const storage = storageGetter();
    if (storage === null) return;
    const data = this.orgArchive.to_dict();
    await storage.put_record(ORG_ARCHIVE_COLLECTION, ORG_ARCHIVE_KEY, data);
  }

  /** 等待进行中的档案快照持久化完成（测试用）。 */
  async flushArchiveSnapshot(): Promise<void> {
    await this.archiveFlush;
  }

  /** 一次执行主线：入口作用域 → 转场循环 → 汇聚点唯一最终产物。 */
  async runExecution(
    request: ExecutionRequest,
    options: RunExecutionOptions = {},
  ): Promise<ExecutionResult> {
    this.init.onRunExecution?.(request);
    const runtime = new ExecutionRuntime({
      load_scope: this.init.loadScope,
      channels: this.channels,
      turn: await this.turnRunner(),
      approval: this.approvalSeam(options.pose, 'execution'),
      priors: this.priors,
      boot_system_prompt: this.init.bootSystemPrompt ?? '',
      guardrails:
        options.guardrails !== undefined && options.guardrails !== null
          ? options.guardrails
          : this.init.guardrails ?? {},
      ...(options.onEvent !== undefined ? { on_event: options.onEvent } : {}),
      archive: this.orgArchive,
      now_ms: this.init.nowMs ?? (() => 0),
    });
    const result = await runtime.run(request);
    this.archiveFlush = this.persistArchiveSnapshot().catch(() => {});
    return result;
  }
}
