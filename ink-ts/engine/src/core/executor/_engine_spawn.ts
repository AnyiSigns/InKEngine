/**
 * 引擎 spawn 展开面（executor.py Engine.run_spawned 移植——公开接口）。
 *
 * 把子任务清单并发展开为子图实例，回收结果回流父图：
 * - 实例隔离：入口状态自包含（清单 state 即实例完整入口；合并累加族通道
 *   归零——回流增量口径，防二次加和翻倍）；
 * - checkpoint 独立子链（``{父thread}:spawn:{index}``），事件统一父链
 *   （graph_path 追加子图名 + 实例序号归属）；
 * - 部分失败剔除（fan_out 语义）：成功结果按 index 升序回流（确定性），
 *   失败实例留痕（error 事件/日志带实例序号与原因），父链继续；实例内
 *   中断 → 提升为父图 interrupt（挂起卡跨层保留，重入语义一致）；
 * - 实例链执行链级 rebase（实例链行数与父链同轴增长；事件日志归父链不裁剪）。
 *
 * spawn 展开事件（ENG3-12）：命令式 ctx.spawn 路径由本处兜底发射
 * spawn_start/spawn_end（数据驱动路径由节点自身发展示形态事件，
 * emit_events=False 跳过——防重复）。
 */
import { InterruptSignal } from '../interrupt/interrupt_types.js';
import { TerminateReason } from '../graph/graph_types.js';
import {
  SpawnFailure,
  SpawnResult,
  type SpawnSpec,
  collect_spawn_specs,
  instance_entry_state,
  instance_thread_id,
} from '../spawn/spawn.js';
import { SPAWN_KEY } from '../spawn/spawn.js';
import { fan_out } from '../fanout/fanout.js';
import { tail_checkpoint } from '../recovery/index.js';
import { subgraph_flowback_overlay } from '../state/schema.js';
import type { NodeContext } from './_internals.js';
import type { _NodeContextImpl } from './_node_context.js';
import { EngineCheckpoint } from './_engine_checkpoint.js';
import { _warn } from './_internals.js';

/** run_spawned 选项（镜像 Python 关键字参）。 */
export interface RunSpawnedOptions {
  concurrency: number;
  emit_events?: boolean;
}

/** spawn 展开分层段（Engine 方法群）。 */
export abstract class EngineSpawn extends EngineCheckpoint {
  /**
   * 把子任务清单并发展开为子图实例，回收结果回流父图（公开接口）。
   *
   * @param specs 子任务清单（路由节点产出，按 index 顺序回流合并）。
   * @param parent_ctx 父图节点上下文（事件透传/中断共享/版本链归属）。
   * @param opts.concurrency 并发上限（fan_out 限流，成本护栏）。
   * @param opts.emit_events 是否发射 spawn_start/spawn_end 事件（数据驱动
   *   路径由节点自身发射展示形态事件，此处传 False 防重复）。
   *
   * @returns SpawnResult：成功实例回流增量（按 index 升序合并，确定性）+
   *   失败清单。
   * @throws InterruptSignal 任一实例内中断（提升为父图挂起卡，重入语义一致）。
   */
  async run_spawned(specs: SpawnSpec[], parent_ctx: NodeContext, opts: RunSpawnedOptions): Promise<SpawnResult> {
    const parent = parent_ctx as _NodeContextImpl;
    const results = new Map<number, Record<string, unknown>>();
    const failures: SpawnFailure[] = [];
    const emitEvents = opts.emit_events ?? true;

    // spawn 展开事件（ENG3-12）：命令式 ctx.spawn 路径此前从未发射
    // spawn_start/spawn_end——本处兜底发射（数据驱动路径由节点自身发展示
    // 形态事件，emit_events=False 跳过）。仅可观测，发射失败不阻断展开。
    if (emitEvents) {
      try {
        await parent_ctx.emit('spawn_start', {
          count: specs.length,
          instances: specs.map((spec) => ({ index: spec.index, name: spec.subgraph.name })),
        });
      } catch {
        // 仅可观测：发射失败不阻断展开
      }
    }

    // 嵌套深度护栏（fail-closed）：子单元深度 = 当前子链深度 + 1；0 =
    // 任意深度（按数据声明关闭校验）；超限直接拒绝展开——递归嵌套是成本
    // 爆炸的高发点，宁可显式失败不可静默放行
    const child_depth = this.options.spawn_depth + 1;
    if (this.options.spawn_max_depth > 0 && child_depth > this.options.spawn_max_depth) {
      throw new Error(`spawn 嵌套深度超限: ${child_depth} > ${this.options.spawn_max_depth}`);
    }

    const run_one = async (position: number): Promise<void> => {
      const spec = specs[position] as SpawnSpec;
      const sub_engine = this._make_instance_engine(spec.subgraph, child_depth);
      const sub_path = [...parent_ctx.graph_path, spec.subgraph.name, String(spec.index)];
      const instance_thread = instance_thread_id(parent.thread_id, spec.index);
      // 恢复：实例从自身链尾续跑（中断/未终态 checkpoint 续跑，同回合挂卡
      // 重入不重跑已完成节点）；终态链尾（reply/stop/error 等 = 上一回合或
      // 已完成的陈旧结果）不作续跑锚点——从头执行，防多轮会话静默沿用旧
      // 结果。从头执行也续接实例链尾（版本链严格线性）。
      let resume_from: number | null = null;
      if (this.options.storage !== null) {
        const tail = await tail_checkpoint(this.options.storage, instance_thread);
        if (tail !== null && (tail.reason === null || tail.reason === 'interrupted')) {
          resume_from = tail.checkpoint_id;
        }
        sub_engine._chain_advanced = true;
      }
      const [final_state, sub_result] = await sub_engine._execute({
        state: instance_entry_state(spec, sub_engine.options.schema),
        thread_id: parent.thread_id,
        round_id: parent_ctx.round_id,
        resume_from,
        trace_id: parent_ctx.trace_id,
        queue: null,
        graph_path: sub_path,
        // 继承父传输链（含顶层 run 队列）：实例事件汇入父事件流——
        // "事件统一父链、前端协议不变"（与静态子图 run_subgraph 同口径）
        transports: parent._transports,
        // checkpoint 独立子链：实例写入实例 thread，事件日志统一父链
        checkpoint_thread_id: instance_thread,
      });
      // 实例事件并入父引擎计数与 seq 锚点（事件统一落父链日志，父引擎后续
      // checkpoint 须以含实例事件的最新 seq 为锚，防恢复重放重复）
      this._event_counter += sub_engine._event_counter;
      // 实例轨迹并入父引擎（结点级成败留痕跨层连续）
      this._trace_merge_from(sub_engine);
      if (sub_engine._latest_event_seq !== null) {
        this._latest_event_seq =
          this._latest_event_seq === null
            ? sub_engine._latest_event_seq
            : Math.max(this._latest_event_seq, sub_engine._latest_event_seq);
      }
      // 实例独立子链同样执行链级 rebase（回合内多轮累计，实例链行数与父链
      // 同轴增长；压缩只动实例链自身，事件日志归父链不裁剪）
      await this._maybe_compact_chain(instance_thread);
      // 实例内中断 → 提升为父图 interrupt（挂起卡跨层保留，重入语义一致）
      if (sub_result.interrupt !== null) {
        throw new InterruptSignal(sub_result.interrupt.key, sub_result.interrupt.payload);
      }
      // 实例步数截止护栏（ENG2-8，与推演分支/多径支流同口径）：实例子链
      // 执行步数超限 = 该实例失败（剔除留痕，父链继续）——探测实例失控的
      // 成本截止点；0 = 按数据声明不校验
      const step_limit = this.options.simulate_max_branch_steps;
      if (step_limit > 0 && sub_engine.executed_node_steps > step_limit) {
        throw new Error(`spawn 实例步数超限: ${sub_engine.executed_node_steps} > ${step_limit}`);
      }
      // 实例终态为 ERROR：不入回流（剔除留痕，父链继续）——部分失败语义
      // 不允许失败实例的部分状态污染父图
      if (sub_result.reason === TerminateReason.ERROR) {
        throw new Error(sub_result.error ?? `spawn 实例执行失败（index=${position}）`);
      }
      // 回流增量（父结构键保护）：子图声明 schema 时只回流声明通道
      // （additive 族须父引擎同族承接），messages/input/tool_rounds 等子图
      // 内部结构键不裸覆盖父会话历史（schema 声明结果通道才回流）
      results.set(
        spec.index,
        subgraph_flowback_overlay(
          instance_entry_state(spec, sub_engine.options.schema),
          final_state,
          sub_engine.options.schema,
          this.options.schema,
        ),
      );
    };

    // 并发展开：部分失败剔除（成功结果回流，父链继续）；实例内中断为控制流
    // 异常（propagate 传播），中断时 fan_out 取消未完成兄弟实例
    const outcome = await fan_out(
      specs.map((_spec, pos) => async (index: number): Promise<void> => {
        void index;
        await run_one(pos);
      }),
      opts.concurrency,
      { propagate: InterruptSignal },
    );
    for (const failure of outcome.failures) {
      const realIndex = failure.index < specs.length ? (specs[failure.index] as SpawnSpec).index : failure.index;
      failures.push(new SpawnFailure({ index: realIndex, error: failure.error }));
    }

    const overlay: Record<string, unknown> = {};
    for (const spec of [...specs].sort((a, b) => a.index - b.index)) {
      const flowback = results.get(spec.index);
      if (flowback !== undefined) {
        Object.assign(overlay, flowback);
      }
    }
    if (emitEvents) {
      try {
        await parent_ctx.emit('spawn_end', {
          count: specs.length,
          succeeded: results.size,
          failed: failures.length,
        });
      } catch {
        // 仅可观测：发射失败不阻断展开
      }
    }
    return new SpawnResult({ overlay, failures });
  }

  /** 清单内是否存在数据驱动来源的 spawn 保留键（节点 overlay 判定用）。 */
  _overlay_has_data_driven_spawn(overlay: Record<string, unknown> | null): boolean {
    return overlay !== null && SPAWN_KEY in overlay;
  }
}

export type { SpawnSpec, SpawnResult, SpawnFailure };
export { collect_spawn_specs };
export { _warn };
