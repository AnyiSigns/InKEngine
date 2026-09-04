/**
 * 引擎决策点推演展开面（executor.py Engine.run_simulated 移植——公开接口）。
 *
 * 决策点推演：分支独立子链执行 → 评估 → 择优/调配 → 返回结果。分支执行
 * 与 spawn 实例同构（半共享上下文 + 独立 checkpoint 子链 + 事件统一父链）；
 * 与 spawn 的差异在结果回收：spawn 全部结果回流，推演只提交择优后的分支
 * （或跨分支组装产物），落选分支保留为轨迹树引用（checkpoint 子链 + 事件
 * parent_step_id）——可回溯对比/换选。
 *
 * 换选路径（branch_pick 非 null）：只执行目标分支——其余分支的结果保留在
 * 各自独立子链（轨迹树引用可回溯对比/换选，无需重算）；目标序号越界/目标
 * 分支不存在或未通过评估 = 换选目标不可用，显式报错（不静默回落择优）。
 *
 * 分支链不做链级压缩：落选分支的轨迹树引用（回溯对比/换选锚点）依赖完整
 * 子链，压缩会削掉中间 checkpoint。
 */
import { InterruptSignal } from '../interrupt/interrupt_types.js';
import { TerminateReason } from '../graph/graph_types.js';
import {
  BestBranchMixer,
  BranchSelection,
  ProvenanceNote,
  SimulationResult,
  simulate_thread_id,
} from '../simulation/simulation.js';
import type { SimulateSpec } from '../simulation/simulation_types.js';
import { EvaluatedBranch } from '../simulation/simulation_types.js';
import { SimulationError } from '../errors.js';
import { fan_out } from '../fanout/fanout.js';
import { tail_checkpoint } from '../recovery/index.js';
import { subgraph_overlay_delta } from '../state/schema.js';
import { is_merge_reducer } from '../state/reducers.js';
import type { NodeContext } from './_internals.js';
import type { _NodeContextImpl } from './_node_context.js';
import { EngineSpawn } from './_engine_spawn.js';
import { _warn } from './_internals.js';

/** run_simulated 选项（镜像 Python 关键字参）。 */
export interface RunSimulatedOptions {
  step_id?: string | null;
  budget?: number | null;
  concurrency: number;
}

/** 推演展开分层段（Engine 方法群）。 */
export abstract class EngineSimulate extends EngineSpawn {
  /**
   * 决策点推演：分支独立子链执行 → 评估 → 择优/调配 → 返回结果。
   *
   * @param specs 推演分支清单（决策点节点产出，index 全局唯一）。
   * @param parent_ctx 父图节点上下文（事件透传/中断共享/版本链归属）。
   * @param opts.step_id 决策点步骤 id（分支事件 parent_step_id，轨迹树根）。
   * @param opts.budget 主线上下文组装预算（透传给调配策略；null = 无限制）。
   * @param opts.concurrency 分支并发上限（fan_out 限流，成本护栏）。
   *
   * @returns SimulationResult：择优结果（选中分支/组装增量/来源留痕）+ 全部
   *   已完成评估的分支 + 分支子链 thread 引用表。
   * @throws InterruptSignal 分支内中断（提升为父图挂起卡，重入语义一致）。
   * @throws SimulationError 评估/调配失败或全部分支失败（决策点无产出，
   *   按节点失败收口，不静默提交空结果）。
   */
  async run_simulated(
    specs: SimulateSpec[],
    parent_ctx: NodeContext,
    opts: RunSimulatedOptions,
  ): Promise<SimulationResult> {
    const parent = parent_ctx as _NodeContextImpl;
    const results = new Map<number, Record<string, unknown>>();
    const branch_threads: Record<number, string> = {};
    const failures: string[] = [];
    // 子单元深度 = 当前子链深度 + 1（分支引擎链内再展开子单元时按此基准校验）
    const child_depth = this.options.spawn_depth + 1;

    const run_one = async (index: number): Promise<void> => {
      const spec = specs[index] as SimulateSpec;
      const sub_engine = this._make_instance_engine(spec.subgraph, child_depth);
      const sub_path = [...parent_ctx.graph_path, spec.subgraph.name, String(spec.index)];
      const branch_thread = simulate_thread_id(parent.thread_id, spec.index);
      branch_threads[spec.index] = branch_thread;
      // 分支入口状态自包含（与 spawn 实例同语义：清单 state 完整入口，合并
      // 累加族通道归零——回流增量 = 分支内新增，防二次加和翻倍）
      const entry_state: Record<string, unknown> = { ...spec.state };
      const sub_schema = sub_engine.options.schema;
      if (sub_schema !== null) {
        for (const [key, channel] of Object.entries(sub_schema.channels)) {
          if (is_merge_reducer(channel.reducer) && key in entry_state) {
            entry_state[key] = {};
          }
        }
      }
      // 恢复：分支从自身链尾续跑（中断/未终态 checkpoint 续跑，同 spawn 实例
      // 语义）；终态链尾 = 陈旧结果，从头执行。
      let resume_from: number | null = null;
      if (this.options.storage !== null) {
        const tail = await tail_checkpoint(this.options.storage, branch_thread);
        if (tail !== null && (tail.reason === null || tail.reason === 'interrupted')) {
          resume_from = tail.checkpoint_id;
        }
        sub_engine._chain_advanced = true;
      }
      const [final_state, sub_result] = await sub_engine._execute({
        state: entry_state,
        thread_id: parent.thread_id,
        round_id: parent_ctx.round_id,
        resume_from,
        trace_id: parent_ctx.trace_id,
        queue: null,
        graph_path: sub_path,
        // 继承父传输链（含顶层 run 队列）：分支事件汇入父事件流，
        // parent_step_id 指向决策点步骤（轨迹树引用）
        transports: parent._transports,
        checkpoint_thread_id: branch_thread,
        parent_step_id: opts.step_id ?? null,
      });
      // 分支事件并入父引擎计数与 seq 锚点（与 spawn 实例同口径）
      this._event_counter += sub_engine._event_counter;
      // 分支轨迹并入父引擎（结点级成败留痕跨层连续）
      this._trace_merge_from(sub_engine);
      if (sub_engine._latest_event_seq !== null) {
        this._latest_event_seq =
          this._latest_event_seq === null
            ? sub_engine._latest_event_seq
            : Math.max(this._latest_event_seq, sub_engine._latest_event_seq);
      }
      if (sub_result.interrupt !== null) {
        throw new InterruptSignal(sub_result.interrupt.key, sub_result.interrupt.payload);
      }
      // 分支步数截止护栏（fail-closed）：分支子链执行步数超限 = 该分支失败
      // （剔除出评估，不静默提交）——探测分支失控的成本截止点；0 = 按数据
      // 声明不校验
      const step_limit = this.options.simulate_max_branch_steps;
      if (step_limit > 0 && sub_engine.executed_node_steps > step_limit) {
        throw new Error(`推演分支步数超限: ${sub_engine.executed_node_steps} > ${step_limit}`);
      }
      if (sub_result.reason === TerminateReason.ERROR) {
        throw new Error(sub_result.error ?? `推演分支执行失败（index=${index}）`);
      }
      results.set(spec.index, subgraph_overlay_delta(entry_state, final_state, sub_schema));
    };

    // 换选路径（branch_pick 非 null）：只执行目标分支——其余分支的结果保留
    // 在各自独立子链（轨迹树引用可回溯对比/换选，无需重算）；正常择优路径
    // 全部分支并行推演。目标序号越界 = 换选目标不存在，显式报错。
    let pick = this.options.branch_pick;
    let run_indexes: number[] = specs.map((_s, i) => i);
    if (pick !== null) {
      if (pick < 0 || pick >= specs.length) {
        throw new SimulationError(
          `换选分支序号越界: ${pick}（当前决策点共 ${specs.length} 个分支）`,
        );
      }
      run_indexes = [pick];
    }
    const outcome = await fan_out(
      // fan_out 的任务序号 = 任务列表位置，经默认参数捕获真实分支序号（换选
      // 路径只跑目标分支时列表位置与分支序号不再对齐）
      run_indexes.map((idx) => async (): Promise<void> => {
        await run_one(idx);
      }),
      opts.concurrency,
      { propagate: InterruptSignal },
    );
    for (const failure of outcome.failures) {
      // 失败索引用真实分支/实例序号（fan_out 的 index 是任务列表位置；换选
      // 路径只跑目标分支时二者不对齐）
      const realIndex = failure.index < specs.length ? (specs[failure.index] as SimulateSpec).index : failure.index;
      failures.push(`#${realIndex}: ${failure.error}`);
    }

    // 分支执行失败剔除（部分失败语义，同 spawn）；全部失败 = 决策点无产出，
    // 显式报错（不静默提交空结果）
    const successful = specs.filter((spec) => results.has(spec.index));
    if (successful.length === 0) {
      throw new SimulationError(`全部分支执行失败: ${failures.join('; ')}`);
    }
    // 分支结果评估（Evaluator 协议：引擎规定产出，评审策略由用户集注入）；
    // 评估失败的分支剔除（该分支无可信评分，不得参与择优）
    const evaluated: EvaluatedBranch[] = [];
    for (const spec of [...successful].sort((a, b) => a.index - b.index)) {
      const overlay = results.get(spec.index) as Record<string, unknown>;
      try {
        const evaluation = await (this.options.evaluator as NonNullable<typeof this.options.evaluator>).evaluate(
          spec,
          overlay,
        );
        evaluated.push(new EvaluatedBranch({ spec, overlay, evaluation }));
      } catch (exc) {
        _warn(`推演分支评估失败（剔除）index=${spec.index}: ${String(exc)}`);
        continue;
      }
    }
    if (evaluated.length === 0) {
      throw new SimulationError('全部成功分支评估失败（无可择优候选）');
    }
    // 分支结果调配：单选或跨分支组装（调配器思想：多个分支结果 = 源、评估分
    // = weight、主线预算 = 预算）；调配失败 = 策略/配置问题，按节点失败收口
    // （fail-fast，不静默单选）。
    pick = this.options.branch_pick;
    let selection: BranchSelection;
    if (pick !== null) {
      const target = evaluated.find((b) => b.spec.index === pick);
      if (target === undefined || !target.evaluation.passed) {
        throw new SimulationError(`换选分支不可用（不存在或未通过评估）: ${pick}`);
      }
      selection = new BranchSelection({
        selected: [pick],
        overlay: { ...target.overlay },
        provenance:
          Object.keys(target.overlay).length > 0
            ? [new ProvenanceNote({ branch_index: pick, key: '*', note: '换选提交' })]
            : [],
      });
    } else {
      // 调配策略选择（ENG12 接线1）：优先顺序 = 用户显式注入 > 单选兜底。
      // 用户未指定 mixer 时仍用 BestBranchMixer 兜底（既有单选语义不漂移）
      const mixer = this.options.branch_mixer ?? new BestBranchMixer();
      try {
        selection = await mixer.mix(evaluated, { budget: opts.budget ?? null });
      } catch (exc) {
        throw new SimulationError(`分支调配失败: ${String(exc)}`);
      }
    }
    return new SimulationResult({
      selection,
      branches: evaluated,
      thread_ids: branch_threads,
    });
  }
}
