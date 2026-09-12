// P6 归位（引擎重排计划 §6 P6 动作 E）：InterruptState 自 loop/interrupt/
// interrupt_types.ts 下移 model——checkpoint 数据形态（storage_records/adapters
// 消费）；interrupt_types.ts 经 re-export 保链（graph/executor、core/run_result
// 等消费者路径不变）。
import { isRecord } from '../json.js';

/** Python 布尔口径：空容器/零/空串/None 皆假值（from_dict 缺省回落依据）。 */
function isFalsy(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * 中断点状态（随 checkpoint 持久化，重入定位锚点）。
 *
 * key：中断点标识（review_key，如 "gate" / "design_session"；gate 审批
 *   第二次起带 ``#N`` 调用级唯一指纹）；
 * payload：挂起负载（审批卡内容等）；
 * node：中断节点（重入起点）；
 * graph_path：嵌套图路径（重入定位）。
 *
 * frozen 语义对齐 Python frozen dataclass：构造即冻结实例（字段只读在运行
 * 时同样成立）；payload 为引用透传（与 Python 一致，内容可变）。graph_path
 * 对齐 tuple 的不可变语义做防御拷贝。
 */
export class InterruptState {
  readonly key: string;
  readonly payload: { [key: string]: unknown };
  readonly node: string | null;
  readonly graph_path: readonly string[];

  constructor(
    key: string,
    payload: { [key: string]: unknown },
    node: string | null = null,
    graph_path: readonly string[] = [],
  ) {
    this.key = key;
    this.payload = payload;
    this.node = node;
    this.graph_path = [...graph_path];
    Object.freeze(this);
  }

  /** 序列化为 JSON 形态（graph_path 元组 → 数组；payload/node 原样透传）。 */
  to_dict(): Record<string, unknown> {
    return {
      key: this.key,
      payload: this.payload,
      node: this.node,
      graph_path: [...this.graph_path],
    };
  }

  /** 从存储记录还原（schema 增量演进兼容）：缺省字段回落默认值（payload={}
   *  node=null / graph_path=[]），与 Python ``dict.get(...) or 缺省`` 同口径。 */
  static from_dict(data: unknown): InterruptState {
    if (!isRecord(data)) {
      throw new TypeError('中断点状态须为字典');
    }
    const rawKey = data['key'];
    if (rawKey === undefined || rawKey === null) {
      throw new Error('中断点状态缺 key 字段');
    }
    const rawPayload = data['payload'];
    const payload = isFalsy(rawPayload)
      ? {}
      : (rawPayload as { [key: string]: unknown });
    const rawNode = data['node'];
    const node = rawNode === undefined || rawNode === null ? null : (rawNode as string);
    const rawPath = data['graph_path'];
    let graph_path: string[];
    if (isFalsy(rawPath)) {
      graph_path = [];
    } else if (Array.isArray(rawPath)) {
      graph_path = rawPath as string[];
    } else if (typeof rawPath === 'string') {
      graph_path = Array.from(rawPath);
    } else {
      throw new Error('graph_path 需可迭代');
    }
    return new InterruptState(rawKey as string, payload, node, graph_path);
  }
}
