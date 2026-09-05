/**
 * 恢复/续流解析（checkpoint 锚点解析 + 增量日志重放 + 子图锚点回溯），
 * recovery.py 移植。
 *
 * executor 的恢复面在此收敛：resume 语义（断线续流/新回合续链/编辑重放）
 * 的锚点选择、输入状态覆盖、事件重放、嵌套子图锚点回溯，全部为纯解析
 * 函数——不触碰引擎运行态（计数器/链尾标志由调用方在解析后设置），
 * 可独立测试。
 *
 * 恢复模型：checkpoint 版本链快照 + 执行事件日志（append-only）——
 * 恢复 = 读取 checkpoint 快照 + 增量日志重放（断线续流）；编辑重放 =
 * 日志截断 + 新分支（truncate_log_after + parent_checkpoint）。
 *
 * 重放纪律：事件只从「最终锚点」重放一次（resume_from 锚点与回溯出的
 * 顶层锚点取后者，其 event_seq 不高于前者，重放区间为超集——先重放
 * 子集再重放超集会在流中出现重复事件）。
 *
 * 已知边界（多径/子图中断收口场景）：JS 无协作取消，中断传播时在途兄弟
 * 任务可能落后于终态 checkpoint 写入（其事件 seq 晚于终态锚点 event_seq）；
 * resume 以锚点 event_seq 为界重放增量日志，可能携带这批迟到事件——重放
 * 集是超集是合法语义（消费方幂等），不做「精确到逐事件」的假设。
 *
 * 移植范围说明：本模块只承载纯解析机制；真实存储后端（memory/sqlite/
 * postgres）属宿主装配层 IO 不在此处；执行器的恢复接线（scheduler
 * resume 路径）随 executor 移植后在宿主侧接入。
 */

import { GraphVersionMismatchError, StorageError } from '../errors.js';
import type { EngineEvent } from '../events/events.js';
import type { JsonRecord } from '../json.js';
import type { CheckpointRecord } from '../storage/storage_records.js';
import { collect_resume_anchors } from './recovery_anchors.js';
import { ResumeResolution } from './recovery_types.js';
import type { ResolveResumeOptions } from './recovery_types.js';

/** 查询版本链链尾（跨引擎续链的 parent 跟随用）。 */
export async function tail_checkpoint(
  storage: { get_latest_checkpoint(thread_id: string): Promise<CheckpointRecord | null> },
  thread_id: string,
): Promise<CheckpointRecord | null> {
  return await storage.get_latest_checkpoint(thread_id);
}

/**
 * 解析恢复起点：初始状态归一化 + 续链/续跑锚点 + 锚点回溯 + 重放清单。
 *
 * 顶层恢复路径（graph_path 为空）契约强制（ENG5-13）：checkpoint 链与
 * 事件日志必须同线程——锚点回溯（chain_index(tail.thread_id)）与增量
 * 重放（events_after(thread_id, ...)）都按单一 thread 定位，分离只允许
 * 出现在嵌套层（spawn/分支经 checkpoint_thread_id 显式隔离，且
 * graph_path 非空不走本路径）。顶层混用会静默跨线程取锚点/重放，恢复
 * 结果错位，断言拒绝。
 *
 * continue_chain 续链：读链尾 checkpoint 为基底，输入 state 经 schema
 * 覆盖合并（消息追加/指标复位等 reducer 语义），从入口执行，版本链续接
 * 链尾——不重放事件（新回合事件全新产生）。图版本不校验：续链无重放/
 * 回溯语义（状态通道继承、事件全新产生），同 thread 换图（按任务切
 * harness）是合法场景——图版本校验只作用于 resume_from（真恢复/重放）。
 *
 * resume_from 恢复续跑：历史链尾可能已推进（上次中断/子图锚点），首写
 * parent 须跟随当前链尾——由调用方置位链尾标志，写入处统一查询。输入
 * state 作为覆盖层：checkpoint 状态为基底，输入中提供的通道值经 reducer
 * 合并（弹卡注入的 decision/清空的一次性状态等），缺失键保留 checkpoint
 * 值。replay 时把 checkpoint 之后的事件补发给传输（断线续流）；顶层锚点
 * 回溯后若找到更近的顶层锚点，重放区间以顶层锚点为准（超集一次，防重复
 * 事件）。顶层引擎（graph_path 空）：锚点可能落在任一层（含嵌套子图内），
 * 沿版本链回溯收集各级恢复锚点（graph_path → checkpoint_id）——中断链
 * 上每级引擎都写有中断 checkpoint（顶层中断锚点的父链含各级子图锚点），
 * 各级从各自最近 checkpoint 恢复，子图锚点经 resume_map 下沉（子图
 * runner 路径匹配时传给子图引擎，跳过祖先节点重执行）。子图引擎
 * （graph_path 非空）收到的 resume_from 已匹配本层路径，直接恢复不再
 * 回溯。顶层锚点缺失（图入口即子图）：本级从入口开始，子图锚点保留在
 * resume_map（到达路径匹配的子图节点时恢复）。
 *
 * 图版本校验只作用于真恢复（resume_from 锚点）：恢复 = 快照 + 事件重放，
 * 图定义（拓扑/节点/条件引用）变了重放语义不保证——显式拒绝
 * （GraphVersionMismatchError）让调用方决定重建或换锚点，绝不静默错位
 * （旧数据无指纹，跳过校验兼容）。
 */
export async function resolve_resume(options: ResolveResumeOptions): Promise<ResumeResolution> {
  const {
    storage,
    state,
    schema,
    thread_id,
    chain_thread,
    resume_from,
    continue_chain,
    graph_path,
    replay,
    resume_map: resumeMapInput,
    graph_version = null,
  } = options;
  // 状态值与 checkpoint.state 同口径（JsonRecord 承载；schema 归约结果
  // 可含 PatchChain 等标记形态，运行时经 storage 序列化契约处理）
  let current_state: JsonRecord =
    schema !== null ? (schema.apply({}, state) as JsonRecord) : { ...state };
  let last_checkpoint: CheckpointRecord | null = null;
  let resume_map = new Map(resumeMapInput ?? []);
  let replay_events: EngineEvent[] = [];
  if (graph_path.length === 0 && storage !== null) {
    // 契约强制（ENG5-13）：顶层恢复路径的 checkpoint 链与事件日志必须
    // 同线程——分离只允许出现在嵌套层（spawn/分支显式隔离且路径非空）
    if (chain_thread !== thread_id) {
      throw new Error(
        `顶层恢复路径 chain_thread(${chain_thread}) 与 thread_id(${thread_id}) 不一致（spawn/分支隔离仅限嵌套路径）`,
      );
    }
  }
  if (continue_chain && storage !== null) {
    last_checkpoint = await storage.get_latest_checkpoint(chain_thread);
    if (last_checkpoint !== null) {
      const base: JsonRecord = { ...last_checkpoint.state };
      current_state =
        schema !== null
          ? (schema.apply(base, state) as JsonRecord)
          : { ...base, ...state };
    }
  } else if (resume_from !== null && storage !== null) {
    last_checkpoint = await storage.get_checkpoint(resume_from);
    if (last_checkpoint === null) {
      throw new StorageError(`恢复锚点不存在: ${resume_from}`);
    }
    // 输入 state 作为覆盖层：checkpoint 状态为基底，输入中提供的
    // 通道值经 reducer 合并（弹卡注入的 decision/清空的一次性状态等），
    // 缺失键保留 checkpoint 值
    current_state = { ...last_checkpoint.state };
    if (Object.keys(state).length > 0) {
      current_state =
        schema !== null
          ? (schema.apply(current_state, state) as JsonRecord)
          : { ...current_state, ...state };
    }
    // 增量日志重放：把 checkpoint 之后的事件补发给传输（断线续流）；
    // 顶层锚点回溯后若找到更近的顶层锚点，重放区间以顶层锚点为准
    // （超集一次，防重复事件）。
    if (replay) {
      replay_events = await storage.events_after(thread_id, last_checkpoint.event_seq);
    }
    // 顶层引擎（graph_path 空）：锚点可能落在任一层（含嵌套子图内），
    // 沿版本链回溯收集各级恢复锚点——子图引擎（graph_path 非空）收到
    // 的 resume_from 已匹配本层路径，直接恢复不再回溯。
    if (graph_path.length === 0) {
      const [top_anchor, collected] = await collect_resume_anchors(
        storage,
        last_checkpoint,
        resume_map,
      );
      resume_map = collected;
      if (top_anchor !== null) {
        // 顶层锚点取自本线程链索引（与链记录同库一致），必然命中；
        // 并发 rebase 删行的极端窗口下与 Python 解引用空值同行为
        last_checkpoint = (await storage.get_checkpoint(top_anchor))!;
        current_state = { ...last_checkpoint.state };
        // 顶层锚点回溯后重新应用输入覆盖层（与 resume_from 分支同语义）：
        // 调用方注入的一次性状态（决议/清空的一次性通道）在任何恢复基底
        // 上都须生效——直接覆盖会静默丢弃
        if (Object.keys(state).length > 0) {
          current_state =
            schema !== null
              ? (schema.apply(current_state, state) as JsonRecord)
              : { ...current_state, ...state };
        }
        if (replay) {
          replay_events = await storage.events_after(thread_id, last_checkpoint.event_seq);
        }
      } else {
        // 顶层锚点缺失（图入口即子图）：本级从入口开始，子图锚点保留
        // 在 resume_map（到达路径匹配的子图节点时恢复）
        last_checkpoint = null;
        current_state = { ...state };
      }
    }
  }
  if (resume_from !== null) {
    // 图版本校验只作用于真恢复（resume_from 锚点）：图定义变了重放语义
    // 不保证；continue_chain 不重放事件，状态通道继承（同 thread 换图是
    // 合法场景），不校验。
    assertGraphVersion(last_checkpoint, graph_version);
  }
  return new ResumeResolution({
    state: current_state,
    last_checkpoint,
    resume_map,
    replay: replay_events,
  });
}

/**
 * 恢复锚点图版本校验：锚点带图指纹且与当前图不一致 → 拒绝续跑。
 *
 * 图定义 = 可恢复状态的一部分：拓扑/节点/条件引用变了，同一份状态与
 * 事件日志的语义就不同——继续重放会产生错位结果。显式报错让调用方
 * 决定重建或换锚点，绝不静默错位（旧数据无指纹，跳过校验兼容）。
 */
function assertGraphVersion(
  checkpoint: CheckpointRecord | null,
  graph_version: string | null,
): void {
  if (graph_version === null || checkpoint === null || checkpoint.graph_version === null) {
    return;
  }
  if (checkpoint.graph_version !== graph_version) {
    throw new GraphVersionMismatchError(
      `图定义版本与恢复锚点不匹配（锚点 ${checkpoint.graph_version.slice(0, 12)}…` +
        ` vs 当前 ${graph_version.slice(0, 12)}…）：图已变更，恢复语义不保证，` +
        '请重建会话或选择匹配的锚点',
    );
  }
}