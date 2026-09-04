/**
 * 恢复解析的数据形态：ResumeResolution 结果 + resume_map 键编码 +
 * resolve_resume 选项面（recovery.py 移植的纯数据面部分）。
 *
 * resume_map 在 Python 侧是 tuple 关键词典（graph_path → checkpoint_id）；
 * TS 无 tuple 哈希，以 graph_path 的 JSON 序列化为键（JSON 转义保证单射，
 * 路径段含任何字符都无歧义）。ResumeResolution 与 Python
 * dataclass(slots=True) 一一对应，字段只读，无构造期副作用。
 */

import type { EngineEvent } from '../events/events.js';
import type { JsonRecord } from '../json.js';
import type { StateSchema } from '../state/schema.js';
import type { Storage } from '../storage/storage.js';
import type { CheckpointRecord } from '../storage/storage_records.js';

/**
 * 嵌套子图恢复锚点表（graph_path → checkpoint_id）。
 *
 * 键编码：graph_path 的 JSON 序列化（Python 元组关键词典在 TS 以字符串
 * 键镜像——JSON.stringify(["s1"])；子图引擎路径匹配时按同编码查表）。
 */
export type ResumeMap = Map<string, number>;

/** 恢复解析结果：基底状态 + 恢复锚点 + 子图锚点表 + 待重放事件。 */
export class ResumeResolution {
  readonly state: JsonRecord;
  readonly last_checkpoint: CheckpointRecord | null;
  readonly resume_map: ResumeMap;
  readonly replay: readonly EngineEvent[];

  constructor(init: {
    state: JsonRecord;
    last_checkpoint: CheckpointRecord | null;
    resume_map?: ResumeMap;
    replay?: readonly EngineEvent[];
  }) {
    this.state = init.state;
    this.last_checkpoint = init.last_checkpoint;
    this.resume_map = init.resume_map ?? new Map();
    this.replay = init.replay ?? [];
    Object.freeze(this);
  }
}

/** resolve_resume 恢复解析选项（镜像 Python 关键字参数；graph_version 缺省 null）。 */
export interface ResolveResumeOptions {
  /** 存储服务（null = 纯内存执行，无恢复语义）。 */
  storage: Storage | null;
  /** 输入状态（无 checkpoint 时的初始值 / 恢复时的覆盖层）。 */
  state: JsonRecord;
  /** 状态通道 schema（null = 全部裸通道覆盖语义）。 */
  schema: StateSchema | null;
  /** 事件日志归属线程（事件重放按此查询）。 */
  thread_id: string;
  /** checkpoint 版本链归属（spawn 实例 = 独立子链）。 */
  chain_thread: string;
  /** checkpoint_id 锚点（恢复/续跑；null = 从头执行）。 */
  resume_from: number | null;
  /** 新回合续链（读链尾为基底，输入 state 覆盖后从入口执行）。 */
  continue_chain: boolean;
  /** 本图执行路径（顶层空数组才做嵌套子图锚点回溯）。 */
  graph_path: readonly string[];
  /** 是否收集增量日志重放（顶层事件流挂载时）。 */
  replay: boolean;
  /** 嵌套子图恢复锚点表（graph_path → checkpoint_id）。 */
  resume_map: ResumeMap | null;
  /** 当前图内容指纹（null = 不校验）。 */
  graph_version?: string | null;
}